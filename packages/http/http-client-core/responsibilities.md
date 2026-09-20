# Responsibilities — http-client-core

The isomorphic engine of the webpieces HTTP client: reads an API contract's decorators and turns each method call into an HTTP request. It takes no position on where the magic context comes from or whether a DI container exists, so `http-client-node` and `http-client-browser` both build on it.

## In Scope

- `ProxyClient` — @ApiPath validation, the route map built from @ApiPath/@Endpoint/@Auth* metadata, shared path/query/body mapping for explicit GET/POST contracts, bodyless GET requests, JSON/form serialization, full-response/manual-redirect calls, the `fetch` call, logging via the `LogApiCallImpl` its subclass's package constructs (required constructor argument — no global), and test-case recording. Two-phase: collaborators on the constructor, per-client state on `init()`
- `buildClientProxy` — the typed `Proxy` trap (including the framework-inspection whitelist) shared by both environment factories
- The OUTBOUND filter chain: `ClientRequest` (the mutable per-call request a filter edits — url, headers, and the EXACT serialized body), `ClientFilter` / `ClientFilterDefinition` (one filter at one priority; highest runs outermost, matching the server's `FilterMatcher`), and running it around the single `sendOnce`. Serialization happens BEFORE the chain, which is what lets a filter sign the exact bytes transmitted instead of forcing the caller to hand-serialize. A filter may invoke the rest of the chain more than once (a validated redirect) or not at all
- `ClientTarget` — the base a `ClientConfig` extends: a logging `svcName` plus an async `resolveBaseUrl()`
- Handing EVERY response — 2xx included — to `ClientRegistry.getErrorTranslator().fromWire(...)` through `ClientErrorTranslator.throwIfFailure`, and GUARANTEEING that a non-2xx can never return normally: the webpieces default runs behind an app translator that forgets to throw. `fromWire` THROWS; it does not return an error the caller must remember to throw. `ApiEndUserError.message` and `ApiBadRequestError.callerMessage` are the caller-safe prose fields.
- Deciding whether a response body may be parsed at all, from its `content-type` (`ResponseBodyReader`) — an infra 502/503/504 serving HTML becomes a status-derived API error rather than a `SyntaxError`.
- Attaching outbound delivery auth per the endpoint's `AuthMode` (@WpAuthOidc bearer via the injected `IdTokenMinter`, @WpAuthSharedSecret value from the bound `Secrets`)

## Out of Scope

- The `Filter` / `Service` / `FilterChain` abstraction the outbound chain is built from → `core-util`, shared with the server's inbound chain so the two are ONE concept
- Any filter that must read a `RequestContext` or resolve DNS (the runtime base-URL override, the SSRF guard) → `http-client-node`. Neither can live here: a browser bundle must contain neither

- NOT deciding what a downstream status means: that is ONE uniform rule now (`ReceivedApiErrorRule`, core-util), identical in node and in the browser — 4xx is MY bug, 5xx is THEIRS, an incoming `ApiDependencyError` passes through, 266 is the end user's own answer. The per-environment `ProxyClient.adaptDownstreamFailure` hook that used to hold node and browser apart is deleted
- Reading the magic context → the abstract `ProxyClient.outboundContextHeaders(destination)` hook, answered by `RequestContextHeaders` (node, via `core-context`) and `ContextMgr` (browser, in `core-util`). This package only DERIVES the `DestinationTrust` from the route's `AuthMode` and passes it down, so trusted context keys never ride to an endpoint that cannot authenticate the caller
- Deciding a base URL from a Cloud Run service name → `gcp-identity`, used by `http-client-node`
- Minting OIDC tokens → `gcp-identity`; this package only accepts an `IdTokenMinter` seam
- Any DI wiring → `http-client-node` (inversify) or the app's own DI (`http-client-browser`)
- Defining the API decorators and error types themselves → `core-util`
- Server-side routing to controllers → `http-routing`

## Notes

Depends only on `@webpieces/core-util` (browser + node), which is what lets it stay isomorphic. The `IdTokenMinter` and `outboundContextHeaders` seams exist precisely so no Node-only import (`async_hooks`, `gcp-identity`, `inversify`) can reach a browser bundle. It is the "contract → HTTP request" direction; `http-routing` is the mirror "contract → handler" direction.
