# Responsibilities — http-client-core

The isomorphic engine of the webpieces HTTP client: reads an API contract's decorators and turns each method call into an HTTP request. It takes no position on where the magic context comes from or whether a DI container exists, so `http-client-node` and `http-client-browser` both build on it.

## In Scope

- `ProxyClient` — @ApiPath validation, the route map built from @ApiPath/@Endpoint/@Auth* metadata, the `fetch` call, logging via `LogApiCall`, and test-case recording. Two-phase: collaborators on the constructor, per-client state on `init()`
- `buildClientProxy` — the typed `Proxy` trap (including the framework-inspection whitelist) shared by both environment factories
- `ClientTarget` — the base a `ClientConfig` extends: a logging `svcName` plus an async `resolveBaseUrl()`
- Translating HTTP responses/status codes into the typed `HttpError` hierarchy (`ClientErrorTranslator`), returning a `TranslatedFailure` that also records WHO decided — an app-registered `ClientRegistry` translation, or the built-in default mapping
- Deciding whether a response body may be parsed at all, from its `content-type` (`ResponseBodyReader`) — an infra 502/503/504 serves HTML, so it becomes a status-typed `HttpError` rather than a `SyntaxError`
- Attaching outbound delivery auth per the endpoint's `AuthMode` (@AuthOidc bearer via the injected `IdTokenMinter`, @AuthSharedSecret value from the bound `Secrets`)

## Out of Scope

- Deciding what a downstream status MEANS to this environment's caller → the abstract `ProxyClient.adaptDownstreamFailure(failure, callId)` hook. The mapping is isomorphic; the meaning is not — a browser rethrows a 4xx unchanged (it is the user's answer), a server turns it into its own 500 (it describes the server's own broken request)
- Reading the magic context → the abstract `ProxyClient.outboundContextHeaders(destination)` hook, answered by `RequestContextHeaders` (node, via `core-context`) and `ContextMgr` (browser, in `core-util`). This package only DERIVES the `DestinationTrust` from the route's `AuthMode` and passes it down, so trusted context keys never ride to an endpoint that cannot authenticate the caller
- Deciding a base URL from a Cloud Run service name → `gcp-identity`, used by `http-client-node`
- Minting OIDC tokens → `gcp-identity`; this package only accepts an `IdTokenMinter` seam
- Any DI wiring → `http-client-node` (inversify) or the app's own DI (`http-client-browser`)
- Defining the API decorators and error types themselves → `core-util`
- Server-side routing to controllers → `http-routing`

## Notes

Depends only on `@webpieces/core-util` (browser + node), which is what lets it stay isomorphic. The `IdTokenMinter` and `outboundContextHeaders` seams exist precisely so no Node-only import (`async_hooks`, `gcp-identity`, `inversify`) can reach a browser bundle. It is the "contract → HTTP request" direction; `http-routing` is the mirror "contract → handler" direction.
