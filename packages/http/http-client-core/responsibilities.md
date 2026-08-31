# Responsibilities — http-client-core

The isomorphic engine of the webpieces HTTP client: reads an API contract's decorators and turns each method call into an HTTP request. It takes no position on where the magic context comes from or whether a DI container exists, so `http-client-node` and `http-client-browser` both build on it.

## In Scope

- `ProxyClient` — @ApiPath validation, the route map built from @ApiPath/@Endpoint/@Auth* metadata, the `fetch` call, logging via the `LogApiCallImpl` its subclass's package constructs (required constructor argument — no global), and test-case recording. Two-phase: collaborators on the constructor, per-client state on `init()`
- `buildClientProxy` — the typed `Proxy` trap (including the framework-inspection whitelist) shared by both environment factories
- The OUTBOUND filter chain: `ClientRequest` (the mutable per-call request a filter edits — url, headers, and the EXACT serialized body), `ClientFilter` / `ClientFilterDefinition` (one filter at one priority; highest runs outermost, matching the server's `FilterMatcher`), and running it around the single `sendOnce`. Serialization happens BEFORE the chain, which is what lets a filter sign the exact bytes transmitted instead of forcing the caller to hand-serialize. A filter may invoke the rest of the chain more than once (a validated redirect) or not at all
- `ClientTarget` — the base a `ClientConfig` extends: a logging `svcName` plus an async `resolveBaseUrl()`
- Translating HTTP responses/status codes into the typed `HttpError` hierarchy (`ClientErrorTranslator`), returning a `TranslatedFailure` that also records WHO decided — an app-registered `ClientRegistry` translation, or the built-in default mapping. The symmetry with the server is in the TYPE and the structured fields (`subType`, `errorCode`, `waitSeconds`, `field`, `guiAlertMessage`), NOT in the prose: a webpieces server sends the real `Error.message` for `HttpUserError` (266) alone and the generic reason phrase for every other status (see `HttpErrorWireMapper` in `http-server`), so callers must branch on the type, never on the text of `message`
- Deciding whether a response body may be parsed at all, from its `content-type` (`ResponseBodyReader`) — an infra 502/503/504 serves HTML, so it becomes a status-typed `HttpError` rather than a `SyntaxError`
- Attaching outbound delivery auth per the endpoint's `AuthMode` (@AuthOidc bearer via the injected `IdTokenMinter`, @AuthSharedSecret value from the bound `Secrets`)

## Out of Scope

- The `Filter` / `Service` / `FilterChain` abstraction the outbound chain is built from → `core-util`, shared with the server's inbound chain so the two are ONE concept
- Any filter that must read a `RequestContext` or resolve DNS (the runtime base-URL override, the SSRF guard) → `http-client-node`. Neither can live here: a browser bundle must contain neither

- Deciding what a downstream status MEANS to this environment's caller → the abstract `ProxyClient.adaptDownstreamFailure(failure, callId)` hook. The mapping is isomorphic; the meaning is not — a browser rethrows a 4xx unchanged (it is the user's answer), a server turns it into its own 500 (it describes the server's own broken request)
- Reading the magic context → the abstract `ProxyClient.outboundContextHeaders(destination)` hook, answered by `RequestContextHeaders` (node, via `core-context`) and `ContextMgr` (browser, in `core-util`). This package only DERIVES the `DestinationTrust` from the route's `AuthMode` and passes it down, so trusted context keys never ride to an endpoint that cannot authenticate the caller
- Deciding a base URL from a Cloud Run service name → `gcp-identity`, used by `http-client-node`
- Minting OIDC tokens → `gcp-identity`; this package only accepts an `IdTokenMinter` seam
- Any DI wiring → `http-client-node` (inversify) or the app's own DI (`http-client-browser`)
- Defining the API decorators and error types themselves → `core-util`
- Server-side routing to controllers → `http-routing`

## Notes

Depends only on `@webpieces/core-util` (browser + node), which is what lets it stay isomorphic. The `IdTokenMinter` and `outboundContextHeaders` seams exist precisely so no Node-only import (`async_hooks`, `gcp-identity`, `inversify`) can reach a browser bundle. It is the "contract → HTTP request" direction; `http-routing` is the mirror "contract → handler" direction.
