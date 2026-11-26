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
`ReactNativeRuntimeConfigError` at construction, naming the missing `fetch` / `deadlines` and linking to
[#1463](https://github.com/deanhiller/webpieces-ts/issues/1463). Nothing is sent first. `HttpClientRuntime.reactNative(...)` itself refuses a missing collaborator
(for plain-JavaScript callers the types cannot stop).

- **Standalone browsers are unaffected**, including Chrome/Safari on phones. A generic
  `window.ReactNativeWebView.postMessage` (or `globalThis.ReactNativeWebView.postMessage`) is a
  WebView hint, not proof of Expo or native capabilities. Its presence now **refuses browser defaults**
  until the shell is explicitly configured as described below. No user-agent sniffing or mandatory
  `react-native`/Expo import.
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
passing one shared `HttpClientRuntime.reactNative(fetch, deadlines)` as the third argument. Standalone browser code needs no change. Embedded WebView code must also migrate as described below. A custom `CallStrategy` that waited with `setTimeout` should wait on its
new third argument, `deadlines` (see [client timeouts](../../../docs/client-timeouts.md)). Direct
`fetch` calls outside the typed client (e.g. media byte-range downloads) are not covered — wire the
same native transport into them yourself.


## Websites inside Expo / React Native WebViews (#1463)

The website is a **different JavaScript runtime** from RN. Importing `expo/fetch` in the website
selects its web fallback; it does not reach native HTTP. `http-client-browser` and
`http-client-core` therefore depend on neither Expo nor React Native. Both an Expo adapter and a
future replacement adapter can implement the existing shared `HttpFetch` + `DeadlineScheduler` API.
There is no process-global registration, fetch patch, or magic truthy `EXPO_CLIENT` flag.

Complete shell bootstrap **before constructing the factory**. The shell must explicitly acknowledge
its host kind, protocol version, current document/session identity and all three native capabilities.
After receiving that acknowledgement over the application's existing trusted bootstrap channel:

```ts
import {
    ClientHttpBrowserFactory, HttpClientRuntime, MobileWebViewHost,
} from '@webpieces/http-client-browser';

// Values below come from the shell's completed bootstrap negotiation, not guessed page globals.
// Forward these same identities to the app's adapter so the native side checks each request/reply.
const host = new MobileWebViewHost(
    'expo-webview', // or 'react-native-webview' for a different native shell
    1,
    bootstrap.documentId,
    bootstrap.sessionId,
    bootstrap.nativeHttp,         // must be true
    bootstrap.nativeDeadlines,    // must be true
    bootstrap.nativeCancellation, // must be true
);
const runtime = HttpClientRuntime.mobileWebView(shellFetch, shellDeadlines, host);
const factory = new ClientHttpBrowserFactory(store, lifecycleListener, runtime);
```

`host` may also be the deserialized JSON acknowledgement: no class prototype or `instanceof` is
required. `mobileWebView` validates it immediately and snapshots/freezes the identity. A missing
transport/scheduler, false/missing capability, unknown host/version or empty identity throws
`MobileWebViewRuntimeConfigError`, with the missing fields, the remedy and the issue link. It is a
configuration error for bootstrap to handle, not a remote HTTP 500 or an application server-bug modal.
It also works without a WebView marker, for shells that deliberately hide that marker.

A marker-present **undeclared/older shell is refused at factory construction**. Passing platform
defaults, or an RN runtime without a WebView acknowledgement, does not bypass it. Upgrade the shell
and bootstrap the page before building clients; do not catch the error and rebuild with browser
fetch. A marker installed between factory and client construction is checked again at client binding.
A shell hiding every marker must supply the explicit runtime: ordinary browser APIs cannot discover
an otherwise invisible embedding. A marker is configuration only, never an authorization boundary.

### Adapter obligations and delivery boundary

This package supplies **the portable injection contract and construction checks**, not an Expo
module, a universal native URL proxy, or a consumer-specific IPC bridge. The application supplies
`shellFetch` and `shellDeadlines`. A declaration cannot prove their implementation is native or that
its live bridge remains available. The adapter must:

- Route through native HTTP and a native end-to-end deadline covering IPC handoff, network and body
  completion. Native timeout/cancellation must close the request and release bounded pending work
  even while page JS is asleep. `now()` must advance during sleep; a late result is rejected on resume.
  A WebView `setTimeout`, including one hidden behind a scheduler, does not satisfy the contract.
- Enforce approved service routes/origins and redirect destinations **natively**, with bounded request,
  response and concurrent-call limits. Do not grant page-provided URLs, headers or tokens unrestricted
  authority. The native side owns credentials; define which untrusted context headers the page may
  forward. Native bearer authentication does not inherit the page's cookies/CORS rules.
- Bind every pending request/reply to native account, document and session epochs. On navigation,
  logout, account change or bridge loss, cancel/reject pending work, ignore stale replies and negotiate
  a fresh runtime before new clients. The frozen host is an acknowledgement, not a live session monitor.
- Preserve HTTP status, headers and body when reconstructing `Response`. Keep transport failures
  separate from HTTP responses: native connection rejection must become the fetch-compatible network
  rejection, deadline/cancel must retain their semantics, and unexpected implementation errors must
  remain errors. Generic IPC RPC error translation attributes a peer's local connection failure to
  the peer (`ApiDependencyError`); wrapping native fetch in such an RPC without a transport-specific
  outcome codec loses `ApiConnectionError`. Verify the adapter through real JSON serialization.
- Explicitly reject unsupported bodies/responses. `HttpFetchInit` sends an optional serialized string
  body and abort signal; buffered JSON RPC is the initial proven use case. A `Response` facade does
  not imply support for streaming, binary or media. Those need their own bounded adapter design;
  do not base64-buffer whole downloads through IPC or silently fall back to page fetch. Adapters
  must test response-body failures as well as headers. No default retries are introduced here;
  native queues must not amplify the configured typed client's retries.

The reproduction and its limitations live in [#1463](https://github.com/deanhiller/webpieces-ts/issues/1463):
a physical Pixel's page HTTP stalled during screen lock while native HTTP and audio continued;
delegating through RN's Expo fetch/native deadlines avoided the stall in the comparison. It tested
transport and deadlines together, not each independently. These portable tests verify construction,
injected transport and deadlines with page timers frozen; they are not a physical Android/iOS
background-execution certification. The consumer must verify its actual bridge, native resource
cleanup, credential/session enforcement and locked-device behavior on each supported platform.
