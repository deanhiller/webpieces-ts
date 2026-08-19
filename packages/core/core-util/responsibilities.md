# Responsibilities — core-util

Lowest-level, zero-dependency utilities shared across webpieces (browser and Node). Provides `toError()` for standardized catch handling, plus the `Header` interface and `ContextKey` class that higher packages build request-context and HTTP-header abstractions on.

## In Scope

- `toError(unknown)` — normalizes any thrown value into a real `Error` (enforced by the catch-error-pattern ESLint rule).
- The `Header` interface (`getHeaderName()`) — the minimal header/context-key abstraction placed here to avoid circular deps.
- `ContextKey` — typed key for non-HTTP context values stored in RequestContext.
- The seven auth-mode decorators on an api contract — `@Public`, `@AuthJwt`, `@AuthOidc`, `@AuthSharedSecret`, `@AuthWebhook`, `@AuthApiKey`, `@AuthLocalOnly` — and the `AuthMode` discriminated union every reader switches on.
- `RuntimeLocality` — the startup-declared `'local' | 'deployed'` token that `@AuthLocalOnly` enforcement reads. A SEAM, not a detector: the framework never reads `process.env` and never names a cloud provider's variable; undeclared reads as `'deployed'` so the answer fails safe.
- Small, dependency-free helpers usable in both browser and Node.

## Out of Scope

- The `RequestContext`/AsyncLocalStorage storage itself — lives in `core-context`.
- `PlatformHeader` and HTTP header implementations — live in `http-api`.
- Mock/test tooling — lives in `core-mock`.
- Anything requiring a runtime dependency — this package must stay zero-dependency.

## Notes (optional)

This is the base of the dependency hierarchy (core-util → core-context → http-api); keeping `Header` here lets RequestContext work with headers without depending on higher-level packages.
