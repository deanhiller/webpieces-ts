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
`CallRegistry` from `@webpieces/core-util` for ALL, API or API-method overrides and explicit retry
strategies — the same `CallRegistry.execute` the node and Cloud Tasks clients run. Any strategy
replaces the entire timeout ladder; there is no default retry because POSTs may not be idempotent.
Opt a contract in with `CallRegistry.setStrategy(new RetryStrategy(...).run, CatalogApi)`: it retries
only a `CallOutcome.TRANSIENT_FAILURE` (from `ClientRegistry.classify`) on a `READ` /
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
