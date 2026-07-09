# Responsibilities — http-client-core

The isomorphic engine of the webpieces HTTP client: reads an API contract's decorators and turns each method call into an HTTP request. It takes no position on where the magic context comes from or whether a DI container exists, so `http-client-node` and `http-client-browser` both build on it.

## In Scope

- `ProxyClient` — @ApiPath validation, the route map built from @ApiPath/@Endpoint/@Auth* metadata, the `fetch` call, logging via `LogApiCall`, and test-case recording. Two-phase: collaborators on the constructor, per-client state on `init()`
- `buildClientProxy` — the typed `Proxy` trap (including the framework-inspection whitelist) shared by both environment factories
- `ClientTarget` — the base a `ClientConfig` extends: a logging `svcName` plus an async `resolveBaseUrl()`
- Translating HTTP responses/status codes into the typed `HttpError` hierarchy (`ClientErrorTranslator`)
- Attaching outbound delivery auth per the endpoint's `AuthMode` (@AuthOidc bearer via the injected `IdTokenMinter`, @AuthSharedSecret value from the bound `Secrets`)

## Out of Scope

- Reading the magic context → the `OutboundHeaders` abstraction in `core-util`, implemented by `RequestContextHeaders` (node) and `ContextMgr` (browser)
- Deciding a base URL from a Cloud Run service name → `gcp-identity`, used by `http-client-node`
- Minting OIDC tokens → `gcp-identity`; this package only accepts an `IdTokenMinter` seam
- Any DI wiring → `http-client-node` (inversify) or the app's own DI (`http-client-browser`)
- Defining the API decorators and error types themselves → `core-util`
- Server-side routing to controllers → `http-routing`

## Notes

Depends only on `@webpieces/core-util` (browser + node), which is what lets it stay isomorphic. The `IdTokenMinter` and `OutboundHeaders` seams exist precisely so no Node-only import (`async_hooks`, `gcp-identity`, `inversify`) can reach a browser bundle. It is the "contract → HTTP request" direction; `http-routing` is the mirror "contract → handler" direction.
