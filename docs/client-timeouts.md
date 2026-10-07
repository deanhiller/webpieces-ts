# Client timeouts and strategies

Browser RPC, node RPC, and Cloud Tasks enqueue calls time out after **30 seconds** by default. A timeout rejects with `ApiCallTimeoutError` from `@webpieces/core-util`; it never silently resolves.

Configure the shared, browser-safe `CallRegistry` at application startup (separately in each browser/server process). Keys use the actual API class identity, not its name. Existing clients read the policy on every call.

```ts
import { CallRegistry } from '@webpieces/core-util';

CallRegistry.setTimeout(5_000, 'ALL');
CallRegistry.setTimeout(10_000, CatalogApi);
CallRegistry.setTimeout(45_000, CatalogApi, 'upload');
```

There are **two separate lookups**, in this order:

1. Strategy: API method → API → ALL → no strategy.
2. Only without a strategy: timeout API method → API → ALL → transport default (currently 30,000ms in all three clients).

**A strategy found at any level replaces the entire timeout ladder**, even a more-specific method timeout. For example, an ALL strategy ignores every registered timeout. The strategy owns every attempt timeout and every backoff. Passing `undefined` to either setter removes that level's setting, exposing the next level. `CallRegistry.clear()` resets policies for test isolation.

Timeouts are milliseconds, positive and finite, at most 2,147,483,647 (the platform timer limit). Invalid registered values and invalid `call(timeoutMs)` values reject configuration/calls instead of accidentally becoming near-immediate platform timers.

## Explicit retry strategy

```ts
import { Attempt, CallStrategy, CallRegistry, ApiCallTimeoutError } from '@webpieces/core-util';

const patientRetry: CallStrategy<unknown> = async (call, ctx) => {
    try {
        return await call(30_000);
    } catch (err) {
        if (!(err instanceof ApiCallTimeoutError)) throw err;
        console.warn(`${ctx.apiName}.${ctx.methodName} timed out; waiting 60s`);
        await new Promise<void>(resolve => setTimeout(resolve, 60_000));
        return call(20_000);
    }
};

// Install only where the application knows a repeated operation is safe.
CallRegistry.setStrategy(patientRetry, CatalogApi, 'upload');
```

`Attempt<T>` is `(timeoutMs: number) => Promise<T>`.
`CallStrategy<T>` is `(call: Attempt<T>, ctx: CallContext) => Promise<T>`.
Context has readonly `apiName`, `methodName` and `operation` — the endpoint's declared `@Endpoint` operation (`READ`, `WRITE_IDEMPOTENT` or `WRITE`), so a strategy can decide whether repeating the call is safe. IPC contracts declare no operation, so an IPC deadline reports the conservative `WRITE`. `CallRegistry.execute(api, context, attempt, defaultMs)` takes that same `CallContext`. `ApiCallTimeoutError` carries `timeoutMs` and `context`. Whatever a strategy throws reaches the caller unchanged, preserving error identity and `instanceof` checks.

## Showing a timeout to an end user

`ApiCallTimeoutError.message` is the developer text (`SaveApi.save timed out after 30000ms`) — keep reporting it to your error tracker. `ApiCallTimeoutError.userMessage` is the stable text to render verbatim, chosen by `context.operation`:

| operation | `userMessage` |
|---|---|
| `READ`, `WRITE_IDEMPOTENT` | The network timed out. It probably just flaked. Please try your request again. |
| `WRITE` | The network timed out. Your change may or may not have been saved — please check before trying again. |

A client deadline is not a gateway failure: check `instanceof ApiCallTimeoutError` before the broader `ApiDependencyTimeoutError`, and never title it "Gateway Timeout" (`WebpiecesDefaultErrorTranslator` gives it the reason phrase `Network Timeout`). `ApiConnectionError.userMessage` is the matching text for a call that could not reach the server at all.

There is deliberately **no default strategy or retry**: retrying a non-idempotent POST can duplicate writes. A timeout only says the client stopped waiting, not that the server stopped executing. Idempotency and deduplication belong to the strategy author.

There is no caller `AbortSignal` in this version's strategy signature. A sleeping strategy continues after navigation and can keep a Node process alive until its timer finishes.

## What an attempt bounds

An HTTP attempt includes URL resolution, outbound filters/auth, fetch, and consuming the success or error body. A 200 response with a stalled body still times out. Each attempt creates fresh mutable headers, body, URL state and an internal abort controller. On timeout, fetch/body consumption is aborted where the platform supports it; a promise race still settles the caller if a transport ignores cancellation. A filter resuming late cannot start a new fetch after its attempt expires.

Browser lifecycle listeners receive one start/end pair for the logical call, including all retries and backoff. Timeout is a failed outcome, with response status/headers when they arrived. Late results cannot produce a second end event. Logging and node recording surround the logical call.

For Cloud Tasks, the registry governs **enqueue only**, including URL resolution and the invoker acknowledgement. Queue delivery retries/backoff and `ScheduleOptions.taskTimeoutSeconds` govern later task execution and are separate. The current task invoker has no cancellation interface, so an enqueue may finish remotely after the client times out. Use stable deduplication names when retrying; a late attempt cannot replace the winning job reference.

## High-level tests without network access

The factory-level suites for [browser](../packages/http/http-client-browser/src/__tests__/ClientTimeouts.spec.ts), [node](../packages/http/http-client-node/src/__tests__/ClientTimeouts.spec.ts) and [Cloud Tasks](../packages/cloud/cloudtasks-client/src/__tests__/ClientTimeouts.spec.ts) call the real generated clients. They replace only `globalThis.fetch` with `vi.stubGlobal` or inject a controlled `TaskInvoker` through the existing provider seam. Fake timers advance the exact 30s / 60s / 20s schedule in milliseconds of test runtime. Real `Response` and `ReadableStream` objects reproduce headers arriving while the body hangs.

The suite checks defaults, both precedence ladders, error identity, late completion, timer cleanup, invalid deadlines, concurrent calls and hung URL/body reads. Restore globals and real timers after each test.

```sh
pnpm exec vitest run packages/http/http-client-browser/src/__tests__/ClientTimeouts.spec.ts packages/http/http-client-node/src/__tests__/ClientTimeouts.spec.ts packages/cloud/cloudtasks-client/src/__tests__/ClientTimeouts.spec.ts
```
