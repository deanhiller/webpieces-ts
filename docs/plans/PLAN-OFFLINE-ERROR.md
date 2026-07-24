# PLAN — Typed `OfflineError` for network rejects across all clients

> Tracking issue: https://github.com/deanhiller/webpieces-ts/issues/429
> Reference implementation already built on `deanhiller/offline-error` in the `webpieces-ts30`
> checkout (commit `44242c5`) — this plan is the design to re-land here on `0.4`.

## Context / problem

A webpieces client cannot tell the caller **"the request never reached a server"** (offline, DNS
failure, connection refused, CORS preflight rejected) apart from **"a bug in our own code threw
during the call"**. Both arrive as an untyped `Error`/`TypeError`.

The information is *computed and then discarded*. `ProxyClient.executeFetch()`
(`packages/http/http-client-core/src/ProxyClient.ts`) already recognises the reject and records it as
`RequestOutcome` **status 0**, then rethrows raw:

```ts
// A network reject (offline, DNS, CORS preflight) means no Response ever existed, so there is
// no status and no headers to report — only status 0 and the failure itself.
let response: Response;
try {
    response = await fetch(url, options);
} catch (err: unknown) {
    const error = toError(err);
    this.onRequestEnd(route, new RequestOutcome(false, 0, undefined, error));
    throw error;   // <-- raw TypeError: "Failed to fetch" — classification thrown away
}
```

`RequestOutcome` even documents status 0 as *"`fetch` itself rejected (network / offline)"*. The
signal is right there at the throw site; it just never becomes a type the caller can switch on.

### Why this matters

With no type, every consuming app resorts to matching **browser message text**. From trytami, now
copied into `ctoteachings/monorepo1`'s `error-angular`:

```ts
message.includes('Failed to fetch') ||
message.includes('Load failed') ||
message.includes('loading dynamically imported module');
```

This is wrong in **both** directions and cannot be fixed at the app layer:

- a genuine bug whose message happens to contain `"Load failed"` is reported to the user as a network
  problem — so a real defect is silently misattributed and never filed;
- a browser rewording its text (or an engine/locale we didn't enumerate) silently reclassifies every
  offline event as a bug.

The user-visible payoff is concrete: *"Please check your network connection."* vs *"You encountered a
client bug"* is the difference between a user fixing their wifi and a user filing a support ticket
against us.

**Goal:** clients throw a typed `OfflineError` on a transport reject, in **both** runtimes, so an app
gets one `instanceof OfflineError` check that behaves identically in an Angular bundle and on Cloud
Run — and never writes browser-message matching again.

## Design

### 1. New error type: `OfflineError` (in `core-util`)

Append to `packages/core/core-util/src/http/errors.ts`. **Extends `Error`, NOT `HttpError`** — there
is no HTTP status (status 0 / no response ever existed). Subclassing `HttpError` would imply a `code`
that does not exist and would make it match `instanceof HttpError` ladders that mean *"the server
replied with a failure"* — a different situation a caller usually wants to retry differently.

```ts
export class OfflineError extends Error {
    constructor(message: string, cause?: Error) {
        super(message, { cause });
        this.name = 'OfflineError';
        Object.setPrototypeOf(this, new.target.prototype);
    }
}
```

Preserve the original failure as `cause` always.

Also add `HttpTooManyRequestsError` (429) here while in this file — it is the one member of the
`HttpError` ladder that never made it over from trytami, forcing apps to check `err.code === 429`
(the exact untyped pattern the ladder exists to avoid).

### 2. Centralised classifier: `networkReject.ts` (in `core-util`)

New file `packages/core/core-util/src/http/networkReject.ts`, browser-safe, zero node deps. The
message list is inherently incomplete and drifts as browsers reword — keeping it in **one** framework
module means an app never writes it and a new wording is fixed once, here.

Two detectors, checked independently:

- **Node/undici system codes** (checked FIRST — a real, stable code beats text): `ECONNREFUSED`,
  `ENOTFOUND`, `EAI_AGAIN`, `ECONNRESET`, `EPIPE`, `ETIMEDOUT`, `UND_ERR_CONNECT_TIMEOUT`,
  `ENETUNREACH`, `EHOSTUNREACH`. **Must walk the `cause` chain** (depth-capped, ~5) — undici's thrown
  `TypeError: fetch failed` carries the useful code one or two levels down in `cause`. Missing this
  walk means node never classifies at all.
- **Browser wordings** (text fallback): `Failed to fetch`, `NetworkError when attempting to fetch
  resource`, `Load failed`, `The network connection was lost`, `loading dynamically imported module`,
  `Network request failed`. Substring tests (zone.js may append the hostname).

Public surface:

```ts
export function isNetworkRejectError(error: Error): boolean;
// OfflineError when it is a transport reject, else `error` untouched (a real bug keeps its type/stack)
export function toNetworkError(error: Error, url: string): Error;
```

### 3. Export from `core-util`

`packages/core/core-util/src/index.ts`: add `OfflineError`, `HttpTooManyRequestsError` to the
`./http/errors` re-export, and `export { isNetworkRejectError, toNetworkError } from
'./http/networkReject';`.

### 4. Wire the two production `fetch` call sites

There are only two in the repo (verified by grep for `await fetch(` outside tests):

**a. `ProxyClient.executeFetch()`** — `packages/http/http-client-core/src/ProxyClient.ts`. This is
the high-leverage one: **`BrowserProxyClient` and `NodeProxyClient` both extend `ProxyClient`**, so
one edit covers both runtimes. Classify BEFORE `onRequestEnd` so a lifecycle listener sees the same
typed error the caller will:

```ts
} catch (err: unknown) {
    const error = toNetworkError(toError(err), url);
    this.onRequestEnd(route, new RequestOutcome(false, 0, undefined, error));
    throw error;
}
```

**b. `InMemoryTaskInvoker.deliver()`** — `packages/cloud/cloudtasks-client/src/InMemoryTaskInvoker.ts`.
This job is detached and deliberately **never rethrows** — classify for the LOG only, so an operator
reads "the target was unreachable" instead of a bare "Failed to fetch":

```ts
} catch (err: unknown) {
    const error = toNetworkError(toError(err), url);
    log.error(`local task ${taskId} delivery to ${url} threw: ${error.message}`);
}
```

## Behaviour change / blast radius

A transport reject now surfaces as `OfflineError` instead of the raw error. One pre-existing test
pins the OLD contract and must be updated (not a regression — the assertion *was* the contract):

- `packages/http/http-client-browser/src/__tests__/BrowserProxyClient.spec.ts` — the
  "NETWORK reject ends with status 0" test asserts `rejects.toThrow('Failed to fetch')` and
  `outcome.error).toBe(networkErr)`. Change to `rejects.toBeInstanceOf(OfflineError)`, assert
  `outcome.error` is an `OfflineError`, and assert `outcome.error.cause === networkErr` (the original
  is still reachable). The status-0 / no-headers / END-marker assertions stay — that behaviour is
  unchanged.

Everything else is additive. `toError` callers that don't care keep working (an `OfflineError` is
still an `Error`).

## Tests

New `packages/core/core-util/src/http/__tests__/networkReject.spec.ts`, pinning both directions:

- every real-world browser wording IS classified (incl. zone.js hostname suffix, dynamic-import
  variants);
- every node system code IS classified, including one nested in the `cause` chain (the undici case);
- an ordinary bug (`TypeError: Cannot read properties of undefined`, `Error: Internal Server Error`)
  is NOT classified — silently relabelling a bug as "offline" hides real defects;
- a self-referential cause chain terminates (depth cap);
- `toNetworkError` returns an `OfflineError` that names the url, keeps `cause`, is `instanceof Error`
  but has no `code` and is NOT an `HttpError`; and passes a genuine bug through by identity.

## Acceptance check

A consumer can delete its `isNetworkOfflineError()` string-matcher entirely and replace it with:

```ts
if (err instanceof OfflineError) {
    return new ErrorDisplay('Network Issues', 'Please check your network connection.', false);
}
```

…correct in Chrome/Firefox/Safari (browser client) AND under `ECONNREFUSED`/DNS failure (node
client), with no string matching anywhere in app code.

## Rollout

1. Land here, publish, bump the consumer's `@webpieces/*` version.
2. In `ctoteachings/monorepo1` `error-angular`: swap the `HttpError`-ladder's offline branch to
   `err instanceof OfflineError`, delete `isNetworkOfflineError()`, and switch the 429 branch from
   `err.code === 429` to `err instanceof HttpTooManyRequestsError`.

## Files touched (from the reference implementation)

| File | Change |
|---|---|
| `packages/core/core-util/src/http/errors.ts` | add `OfflineError`, `HttpTooManyRequestsError` |
| `packages/core/core-util/src/http/networkReject.ts` | **new** — classifier |
| `packages/core/core-util/src/index.ts` | export the above |
| `packages/http/http-client-core/src/ProxyClient.ts` | classify in the network-reject catch (covers browser+node) |
| `packages/cloud/cloudtasks-client/src/InMemoryTaskInvoker.ts` | classify for the delivery-failure log |
| `packages/core/core-util/src/http/__tests__/networkReject.spec.ts` | **new** — 18 tests |
| `packages/http/http-client-browser/src/__tests__/BrowserProxyClient.spec.ts` | update the one test that pinned the old raw-rethrow contract |
