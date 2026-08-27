# Responsibilities — core-util

Lowest-level, zero-dependency utilities shared across webpieces (browser and Node). Provides `toError()` for standardized catch handling, plus the `Header` interface and `ContextKey` class that higher packages build request-context and HTTP-header abstractions on.

## In Scope

- `Filter` / `Service` / `FilterChain` — the filter-chain abstraction BOTH chains are built from: the server's inbound `Filter<MethodMeta, WpResponse<unknown>>` (`http-routing`) and the client's outbound `Filter<ClientRequest, Response>` (`http-client-core`). Declared once, here, in the package both depend on, so they cannot drift into two spellings of one concept. Dependency-free and browser-safe, like everything else in this package. Priority lives on the registering DEFINITION, never on the filter
- `WebpiecesCoreHeaders.OVERRIDE_BASE_URL` — the context key carrying ONE outbound call's destination when that destination is data rather than deployment. Untrusted (it comes from a partner-editable row) and deliberately NOT transferred over the wire: it names where THIS hop goes, and a callee inheriting it would re-point its own outbound calls at the same host

- `toError(unknown)` — normalizes any thrown value into a real `Error` (enforced by the catch-error-pattern ESLint rule).
- The `Header` interface (`getHeaderName()`) — the minimal header/context-key abstraction placed here to avoid circular deps.
- `ContextKey` — typed key for non-HTTP context values stored in RequestContext.
- The seven auth-mode decorators on an api contract — `@Public`, `@AuthJwt`, `@AuthOidc`, `@AuthSharedSecret`, `@AuthWebhook`, `@AuthApiKey(regime, credentials)`, `@AuthLocalOnly` — and the `AuthMode` discriminated union every reader switches on.
- DECLARING where a partner credential rides, on the contract: `@AuthApiKey`'s ordered, non-empty `ApiKeyCredential[]` (`{in: 'header', name}` or `{in: 'bearer'}`, each with an optional `description`). It is description, not handling — the framework extracts no header; `ApiKeyHook` still owns the pair-check. It exists so a spec generator can DERIVE `components.securitySchemes` plus one ANDed security requirement instead of a human hand-writing them into a manifest that then drifts from the hook's header constants with no build signal.
- `RuntimeLocality` — the startup-declared `'local' | 'deployed'` token that `@AuthLocalOnly` enforcement reads. A SEAM, not a detector: the framework never reads `process.env` and never names a cloud provider's variable; undeclared reads as `'deployed'` so the answer fails safe.
- Small, dependency-free helpers usable in both browser and Node.

## Out of Scope

- The `RequestContext`/AsyncLocalStorage storage itself — lives in `core-context`.
- `PlatformHeader` and HTTP header implementations — live in `http-api`.
- Mock/test tooling — lives in `core-mock`.
- Anything requiring a runtime dependency — this package must stay zero-dependency.

## Notes (optional)

This is the base of the dependency hierarchy (core-util → core-context → http-api); keeping `Header` here lets RequestContext work with headers without depending on higher-level packages.
