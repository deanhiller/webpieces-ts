# Client timeouts, retries and strategies

Browser RPC, node RPC and Cloud Tasks enqueue all run through ONE implementation: `CallRegistry.execute` in `@webpieces/core-util`. A strategy registered at ALL / API / method governs every transport identically. The only per-transport difference is the `TransportDefault` each passes — what happens when nobody registered anything:

| transport | `TransportDefault` | meaning |
|---|---|---|
| browser + node RPC (`ProxyClient`) | `new TransportDefault(30_000)` | one attempt, 30 s deadline, **no retry** |
| Cloud Tasks enqueue (`TaskProxyClient`) | `new TransportDefault(30_000, new RetryStrategy(5_000, 3, 500, 2, 4_000).run)` | **retries**: 5 s per attempt, 3 retries, backoff 500 ms ×2 capped at 4 s |

A deadline rejects with `ApiCallTimeoutError`; it never silently resolves.

Configure the shared, browser-safe `CallRegistry` at application startup (separately in each browser/server process). Keys use the actual API class identity, not its name. Existing clients read the policy on every call.

```ts
import { CallRegistry, RetryStrategy } from '@webpieces/core-util';

CallRegistry.setTimeout(5_000, 'ALL');
CallRegistry.setTimeout(10_000, CatalogApi);
CallRegistry.setTimeout(45_000, CatalogApi, 'upload');
CallRegistry.setStrategy(new RetryStrategy(2_000, 5, 200, 2, 2_000).run, CatalogApi);
```

The ladder, in this order:

1. Strategy: API method → API → ALL.
2. Only without a registered strategy: timeout API method → API → ALL — one attempt with that deadline.
3. Only with neither: the transport's `TransportDefault` (its timeout, and its strategy if it has one).

**A strategy found at any level replaces the entire timeout ladder**, even a more-specific method timeout. **A registered timeout replaces the transport default, including its strategy**: registering `CallRegistry.setTimeout(10_000, EmailApi)` makes that contract's enqueue a single 10 s attempt. To keep retrying with a different attempt deadline, register a `RetryStrategy` instead. Passing `undefined` to either setter removes that level's setting, exposing the next level. `CallRegistry.clear()` resets policies for test isolation.

Timeouts are milliseconds, positive and finite, at most 2,147,483,647 (the platform timer limit). Invalid registered values and invalid `call(timeoutMs)` values reject configuration/calls instead of accidentally becoming near-immediate platform timers.

## `RetryStrategy` — the one shared retry

`new RetryStrategy(attemptTimeoutMs, maxRetries, initialDelayMs, delayMultiplier, maxDelayMs)`; register its `.run`.

It asks two questions with two owners:

- **The error** — `ClientRegistry.classify(error, methodInfo)` returns a `CallOutcome`. Only `TRANSIENT_FAILURE` is retried (unavailable, connection, timeouts, 429 / backoff, bad-gateway). `EXPECTED` and `FAILURE` are definitive and rethrown unchanged. See [portable IPC and errors](portable-ipc-and-errors.md) for the classifier tiers.
- **The endpoint** — `CallContext.operation`. A `WRITE` is **never** retried, even with the strategy registered at ALL: a transient failure on a non-idempotent write may already have happened. `READ` and `WRITE_IDEMPOTENT` are retried. Cloud Tasks enqueue reports `WRITE_IDEMPOTENT` (every attempt carries the same task name).

When it actually retried and ran out it throws `ApiRetriesExhaustedError` (`cause` = the last attempt's error, `attempts` = how many ran). That error is classified `FAILURE` and published as **HTTP 502**, never 503, so no layer above retries again: retries happen at ONE layer. A call that made a single attempt rethrows its own error unchanged.

### The stock strategy for browser, node and React Native clients (#1293)

There is no second "retry-safe operations" strategy: `RetryStrategy` IS it. It lives in `@webpieces/core-util` (tagged browser + node + react-native), so one registration serves every client:

```ts
// once, at app startup — a browser bundle, an Expo shell, or a node server
CallRegistry.setStrategy(new RetryStrategy(10_000, 2, 250, 2, 1_000).run, 'ALL');
```

Registered at ALL it retries `ApiConnectionError` and `ApiCallTimeoutError` (and the other transient kinds above) only on `READ` / `WRITE_IDEMPOTENT` endpoints, never a `WRITE` — a dropped connection does not prove the request never left. In a browser, a connection failure arrives as `ApiConnectionError` because the browser client bypasses Angular's service worker by default (see the [browser client README](../packages/http/http-client-browser/README.md)); without that, ngsw's synthetic 504 would hide it.

## Logging each attempt

`CallRegistry.execute` wraps the attempt BEFORE handing it to any strategy — `RetryStrategy` or one you wrote — so every RETRIED transient attempt logs one line:

```
WARN [API-client-attempt-TRANSIENT] EmailApi.send attempt 2 errorType=ApiUnavailableError error=…
```

The line for attempt N is written when attempt N+1 starts, so the last failure is never logged twice: `LogApiCall`'s final line covers what escaped, and is final by position — `EXPECTED` → `WARN [API-*-resp-OTHER]`, `FAILURE` or `TRANSIENT_FAILURE` → `ERROR [API-*-resp-FAIL]`. A call that gave up after 4 attempts logs 3 attempt lines and 1 FAIL line (`errorType=ApiRetriesExhaustedError`).

## Writing your own strategy

```ts
import { Attempt, CallStrategy, CallRegistry, ApiCallTimeoutError } from '@webpieces/core-util';

const patientRetry: CallStrategy<unknown> = async (call, ctx) => {
    try {
        return await call(30_000);
    } catch (err) {
        if (!(err instanceof ApiCallTimeoutError)) throw err;
        await new Promise<void>(resolve => setTimeout(resolve, 60_000));
        return call(20_000);
    }
};

// Install only where the application knows a repeated operation is safe.
CallRegistry.setStrategy(patientRetry, CatalogApi, 'upload');
```

`Attempt<T>` is `(timeoutMs: number) => Promise<T>`.
`CallStrategy<T>` is `(call: Attempt<T>, ctx: CallContext) => Promise<T>`.
Context has readonly `apiName`, `methodName` and `operation` — the endpoint's declared `@Endpoint` operation (`READ`, `WRITE_IDEMPOTENT` or `WRITE`), so a strategy can decide whether repeating the call is safe. IPC contracts declare no operation, so an IPC deadline reports the conservative `WRITE`. `CallRegistry.execute(api, context, attempt, fallback: TransportDefault)` takes that same `CallContext`. `ApiCallTimeoutError` carries `timeoutMs` and `context`. Whatever a strategy throws reaches the caller unchanged, preserving error identity and `instanceof` checks.

## Showing a timeout to an end user

`ApiCallTimeoutError.message` is the developer text (`SaveApi.save timed out after 30000ms`) — keep reporting it to your error tracker. `ApiCallTimeoutError.userMessage` is the stable text to render verbatim, chosen by `context.operation`:

| operation | `userMessage` |
|---|---|
| `READ`, `WRITE_IDEMPOTENT` | The network timed out. It probably just flaked. Please try your request again. |
| `WRITE` | The network timed out. Your change may or may not have been saved — please check before trying again. |

A client deadline is not a gateway failure: check `instanceof ApiCallTimeoutError` before the broader `ApiDependencyTimeoutError`, and never title it "Gateway Timeout" (`WebpiecesDefaultErrorTranslator` gives it the reason phrase `Network Timeout`). `ApiConnectionError.userMessage` is the matching text for a call that could not reach the server at all.

RPC deliberately has **no default retry**: retrying a non-idempotent POST can duplicate writes. A timeout only says the client stopped waiting, not that the server stopped executing.

There is no caller `AbortSignal` in this version's strategy signature. A sleeping strategy continues after navigation and can keep a Node process alive until its timer finishes.

## What an attempt bounds

An HTTP attempt includes URL resolution, outbound filters/auth, fetch, and consuming the success or error body. A 200 response with a stalled body still times out. Each attempt creates fresh mutable headers, body, URL state and an internal abort controller. On timeout, fetch/body consumption is aborted where the platform supports it; a promise race still settles the caller if a transport ignores cancellation. A filter resuming late cannot start a new fetch after its attempt expires.

Browser lifecycle listeners receive one start/end pair for the logical call, including all retries and backoff. Timeout is a failed outcome, with response status/headers when they arrived. Late results cannot produce a second end event. Logging and node recording surround the logical call.

## Cloud Tasks enqueue

The registry governs **enqueue only** — the `createTask` gRPC call, including URL resolution — never queue DELIVERY, whose retries are the queue's `retryConfig` and whose execution deadline is `ScheduleOptions.taskTimeoutSeconds`.

Every enqueue is retry-safe by construction: the task name is resolved ONCE per logical enqueue (`TaskName.generated()` by default, `TaskName.dedup(key)` for the caller's own key), so every attempt carries the same name. An attempt whose response was lost but whose task landed makes the retry answer ALREADY_EXISTS, which is success: `WARN [ENQUEUE-DEDUP]`, `JobReference.alreadyExisted = true`. `TaskName.serverAssigned()` opts out (fastest `createTask`; a retry may duplicate).

Exactly one retry layer runs per enqueue:

- **Path A — no gax options (the default): webpieces owns timing.** The ladder above, ending in the enqueue `RetryStrategy`. Each attempt sends `createTask(request, { timeout: attemptMs })` — a real gRPC deadline per attempt, no gax retry loop. The gRPC deadline equals the attempt deadline, so gRPC itself cancels a hung RPC.
- **Path B — `ScheduleOptions.gax` or `GcpTaskRegistry.setGax(...)` set: you own timing.** No strategy lookup and ONE attempt, sending `createTask(request, yourGax)` as given, under a safety cap from the timeout ladder (method → API → ALL → 30 s) so a hung channel cannot block forever. Raise the cap with `CallRegistry.setTimeout(...)` to give gax retries room. On `@google-cloud/tasks` 6.3.0 / google-gax 5, a gax retry gets a real per-attempt deadline (google-gax 4 sent 0 ms to every retry). `createTask`'s public promise exposes no `cancel()`, so when the safety cap fires first the RPC is left to gax's own `timeout`.

## High-level tests without network access

The factory-level suites for [browser](../packages/http/http-client-browser/src/__tests__/ClientTimeouts.spec.ts), [node](../packages/http/http-client-node/src/__tests__/ClientTimeouts.spec.ts) and [Cloud Tasks](../packages/cloud/cloudtasks-client/src/__tests__/ClientTimeouts.spec.ts) call the real generated clients. They replace only `globalThis.fetch` with `vi.stubGlobal` or inject a controlled `TaskInvoker` through the existing provider seam. Fake timers advance the exact schedules in milliseconds of test runtime. Real `Response` and `ReadableStream` objects reproduce headers arriving while the body hangs. [`RetryStrategy.spec.ts`](../packages/core/core-util/src/http/__tests__/RetryStrategy.spec.ts) pins the strategy, the attempt lines and the 502 round trip; [`GcpTaskInvoker.grpc.spec.ts`](../packages/cloud/cloudtasks-client/src/__tests__/GcpTaskInvoker.grpc.spec.ts) runs the real `GcpTaskInvoker` and `CloudTasksClient` against a local fake gRPC server.

```sh
pnpm exec vitest run packages/http/http-client-browser/src/__tests__/ClientTimeouts.spec.ts packages/http/http-client-node/src/__tests__/ClientTimeouts.spec.ts packages/cloud/cloudtasks-client/src/__tests__/ClientTimeouts.spec.ts
```
