# @webpieces/http-client-browser

The browser HTTP client. The client and the server share ONE API contract; calling a method on the
client makes the HTTP request the server's controller answers.

DI-free on purpose — this may be bundled by React or Angular, so it ships no inversify and no
`@webpieces/core-context`. Browsers have no ambient request scope, so the app holds a
`MutableContextStore` and sets values as they become known; every outbound call transfers them.

```ts
HeaderRegistry.configure(AppHeaders.getAllHeaders(), CompanyHeaders.getAllHeaders(), true);

const store = new MutableContextStore();
const factory = new ClientHttpBrowserFactory(store);
const saveApi = factory.createRpcClient(SaveApi, new ClientConfig('server', ClientRole.END_USER_CLIENT));

const res = await saveApi.save({ query: 'test' });   // type-safe

// ClientRole is required, with no default. A browser bundle acts for a person, so it declares
// END_USER_CLIENT and a received 401 decodes as ApiUnauthorizedError ("log in again").

// later, after login — every subsequent call carries these
store.set(WebpiecesCoreHeaders.AUTHORIZATION, token);
store.set(CompanyHeaders.TENANT_ID, tenantId);
```

A browser cannot hold service credentials, so a contract with an `oidcSameProject()` / `oidcSvcs(...)` endpoint fails fast at
`createRpcClient`. The server twin is [@webpieces/http-client-node](../http-client-node).

Calls have a **30-second default timeout**, including reading the response body. Configure
`ClientRegistry` from `@webpieces/core-util` for ALL, API or API-method overrides and explicit retry
strategies — the same `ClientRegistry.execute` the node and Cloud Tasks clients run. Any strategy
replaces the entire timeout ladder; there is no default retry because POSTs may not be idempotent.
Opt a contract in with `ClientRegistry.setStrategy(new RetryStrategy(...).run, CallScope.api(CatalogApi))`: it retries
only a `CallOutcome.TRANSIENT_FAILURE` (from `ApiRegistry.classify`) on a `READ` /
`WRITE_IDEMPOTENT` endpoint, logs each retried attempt as `[API-client-attempt-TRANSIENT]`, and gives
up with a 502 `ApiRetriesExhaustedError`. See [client timeouts and testing](../../../docs/client-timeouts.md).

## Angular's service worker is bypassed by default (#1293)

Angular's service worker (ngsw) intercepts every fetch, cross-origin RPC included, and when the network
rejects it answers with a synthetic `504 Gateway Timeout` instead of passing the rejection on — so a
dropped connection looked exactly like a real gateway timeout. Every RPC url therefore carries the
`ngsw-bypass=true` QUERY parameter (not the header: a custom header is not CORS-safelisted). The fetch
then rejects natively and is typed `ApiConnectionError`; a 504 always means a real gateway timeout
(`ApiDependencyTimeoutError`). webpieces servers bind query parameters by name, so the extra key is ignored.

An app that wants its service worker to serve or cache a contract opts out per client with
`new ClientConfig(svc, role, CallMode.FOREGROUND, ServiceWorkerRouting.ALLOW)`. The fallback still
applies: ngsw's synthetic response (status 504, statusText `Gateway Timeout`, null body, NO headers)
is re-typed as `ApiConnectionError` whose `cause` is a `ServiceWorkerSyntheticResponseError` holding the
`Response`. A real gateway 504 has headers and stays `ApiDependencyTimeoutError`.

## Background calls: a per-call marker carried on the error (#1293)

Whether the user waits on a call depends on the CALL SITE — the same `listItems` is foreground behind a
Refresh button and background behind a poll timer. Build a second client for the same contract:

```ts
const itemsApi = factory.createRpcClient(ItemsApi, new ClientConfig('server', ClientRole.END_USER_CLIENT));
const itemsPoller = factory.createRpcClient(
    ItemsApi,
    new ClientConfig('server', ClientRole.END_USER_CLIENT, CallMode.BACKGROUND),
);
```

A BACKGROUND client's routes reach the `RequestLifecycleListener` with `route.hideProgress === true` and
`route.callMode === CallMode.BACKGROUND`, so no endpoint declaration is needed to keep a poll out of the
progress bar. Every failure it rejects with carries `err.callMode === CallMode.BACKGROUND` (typed on
`ApiError`; `CallModeMarker.of(err)` reads it off any thrown value), so a global `ErrorHandler` can
"log + report, no dialog" with no app-side bookkeeping. The error's class is unchanged — every
`instanceof` keeps working — and the property is non-enumerable, so it never reaches JSON or a log
record. A client bound with `Binder.createRpcClientAndBind` is FOREGROUND.

## React Native

The same typed client runs in React Native JavaScript, but there it needs an explicit runtime (#1445).
React Native's default `fetch` (whatwg-fetch over XHR, which settles through `setTimeout(..., 0)`) and
its JS timers can stop progressing while an Android phone is locked, while native-delivered callbacks
keep running. A call deadline built on JS timers therefore cannot fire either. So each React Native
factory takes an `HttpClientRuntime` with two native-backed collaborators:

```ts
import { fetch as expoFetch } from 'expo/fetch';
import { ClientHttpBrowserFactory, HttpClientRuntime, MutableContextStore } from '@webpieces/http-client-browser';

// once, at startup — and pass the SAME runtime to EVERY React Native factory you build
const runtime = HttpClientRuntime.reactNative(expoFetch, nativeDeadlineScheduler);
const factory = new ClientHttpBrowserFactory(store, lifecycleListener, runtime);
```

- **`fetch`** — any `HttpFetch`: `(url: string, init: HttpFetchInit) => Promise<Response>`. Expo SDK 55's
  `expo/fetch` (whose `FetchResponse` implements `Response`) is accepted as-is, with no cast; so is any
  other native-backed transport with that shape. It receives exactly the URL, method, headers (context and
  JWT included), serialized body, redirect mode and abort signal the platform `fetch` would have.
- **`deadlines`** — a `DeadlineScheduler` (`@webpieces/core-util`):
  `schedule(delayMs, onExpire): DeadlineTimer` (with `cancel()`) and `now(): number`. Every call
  deadline and every `RetryStrategy` backoff is scheduled through it; nothing on the call path touches a
  JS timer. It must be **native-backed** — wrapping `setTimeout`, or `AbortSignal.timeout`, is the very
  thing that stalls. `now()` should be a clock that keeps counting while the device sleeps (Android
  `SystemClock.elapsedRealtime()`): when a result arrives after the budget and the native callback never
  got through, the call still fails with `ApiCallTimeoutError` instead of returning late.

webpieces ships no native module and no Expo/React Native dependency — the scheduler is the app's. The
tested integration example is
[`src/__tests__/fixtures/NativeDeadlineScheduler.ts`](src/__tests__/fixtures/NativeDeadlineScheduler.ts):
a `NativeTimerModule` bridge (`start(id, delayMs)`, `cancel(id)`, a synchronous `elapsedRealtimeMs()`, and
one "fired" event the app forwards to `scheduler.deliver(id)`) plus the ~40-line adapter over it.
`InjectedRuntime.spec.ts` drives it with JS timers frozen and proves the deadline still aborts a stalled
transport, a transport that ignores abort, and a body that never finishes.

Guarantees, per call: the deadline covers URL resolution, filters, serialization, the send and the
response body — the same end-to-end budget as before, not just time-to-headers. It is cancelled exactly
once on every outcome; a late native callback after the call settled is ignored; the deadline's typed
`ApiCallTimeoutError` wins over the abort-induced transport rejection; each retry attempt gets a fresh
deadline and the backoff never extends one.

### How React Native is detected — and what is refused

The factory checks for the React Native **JavaScript runtime**, via `navigator.product === 'ReactNative'`
(set by React Native's `Libraries/Core/setUpNavigator.js`; verified on 0.83.10). In that runtime,
`new ClientHttpBrowserFactory(store)` — and passing `HttpClientRuntime.platformDefaults()` — throws
`ReactNativeRuntimeConfigError` at construction, naming the missing `fetch` / `deadlines` and linking
here. Nothing is sent first. `HttpClientRuntime.reactNative(...)` itself refuses a missing collaborator
(for plain-JavaScript callers the types cannot stop).

- **Browsers and WebView pages are unaffected.** A website inside a React Native WebView runs on the
  browser engine's fetch and timers; `window.ReactNativeWebView` does not count as React Native, and
  neither does `window` / `document` presence (React Native has window-like globals). No user-agent
  sniffing, and no `react-native` import.
- **Node, SSR, workers and tests** (no `navigator`, or no `product`) keep the platform defaults and never
  throw on a missing global.
- **Detection limits.** A runtime that hides or rewrites `navigator.product` is not detected — declare it
  by passing `HttpClientRuntime.reactNative(...)`, which works with or without the marker. And no check
  can PROVE a function is background-safe: `reactNative(fetch, deadlines)` is your explicit
  acknowledgement, not an identity test of `expoFetch`.
- **What no runtime can promise.** If the OS suspends or kills the process, no JavaScript runs at all —
  the native side must cancel its own network request, and the JS deadline rejects promptly on resumption.
  Browsers throttle timers in background tabs; that is unchanged.

### Migration (breaking behavior change)

Before #1445, a React Native app that built `new ClientHttpBrowserFactory(store)` silently got the default
`fetch` and JS timers — and stalled while locked. It now **fails at startup** with
`ReactNativeRuntimeConfigError`. Fix every React Native factory (auth, heartbeat, log shipping, …) by
passing one shared `HttpClientRuntime.reactNative(fetch, deadlines)` as the third argument. Browser and
WebView code needs no change. A custom `CallStrategy` that waited with `setTimeout` should wait on its
new third argument, `deadlines` (see [client timeouts](../../../docs/client-timeouts.md)). Direct
`fetch` calls outside the typed client (e.g. media byte-range downloads) are not covered — wire the
same native transport into them yourself.
