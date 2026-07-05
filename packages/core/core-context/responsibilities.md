# Responsibilities — core-context

AsyncLocalStorage-based request-scoped context (a TypeScript port of Java webpieces' ThreadLocal Context/MDC). Exposes the RequestContext singleton to run(), get/put/remove/clear, and copy/restore key-value data automatically across async boundaries.

## In Scope

- The `RequestContext` singleton wrapping Node `AsyncLocalStorage` for request-scoped storage.
- `run()`/`runWithContext()` to establish a context at request start.
- Key/value accessors: `put`, `get`, `remove`, `clear`, `has`, `getAll`, `isActive`.
- Header-typed accessors (`getHeader`/`putHeader`/`hasHeader`/`getHeaders`) keyed via the `Header` abstraction.
- `copyContext()`/`setContext()` for preserving context across async hops (e.g. XPromise).

## Out of Scope

- The `Header`/`ContextKey` type definitions themselves — those live in `core-util` (lowest-level package).
- HTTP header semantics or `PlatformHeader` implementations — belong in `http-api`.
- Generic utility/error helpers — belong in `core-util`.

## Notes (optional)

Depends only on Node built-ins plus the `Header` interface from `core-util`, deliberately keeping it below `http-api` to avoid circular dependencies. `put`/`setContext` throw if no context is active.
