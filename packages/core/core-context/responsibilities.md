# Responsibilities — core-context

AsyncLocalStorage-based request-scoped context (a TypeScript port of Java webpieces' ThreadLocal Context/MDC). Exposes the RequestContext singleton to run(), get/put/remove/clear, and copy/restore key-value data automatically across async boundaries.

## In Scope

- The `RequestContext` singleton wrapping Node `AsyncLocalStorage` for request-scoped storage.
- `run()`/`runWithContext()` to establish a context at request start.
- Raw string accessors (`put`, `get`, `remove`, `has`) for the framework's own reserved, UNREGISTERED
  slots; they REJECT any name belonging to a registered `ContextKey`, so they cannot be used to read or
  forge a trusted value. Plus `clear`, `getAll`, `isActive`.
- Trust-typed accessors (`getTrusted`/`getUntrusted`/`putTrusted`/`putUntrusted`, plus `getAny` for
  framework serialization and `hasKey`/`removeKey`) keyed by a `ContextKey`. The verb states whether the
  value was PROVEN or merely asserted, and the wrong kind of key does not compile.
- `PendingWireTrust` — the holding pen for inbound wire values of TRUSTED keys, admitted or rejected by
  `AuthFilter` once the route's auth mode says whether the caller itself was verified.
- `copyContext()`/`setContext()` for preserving context across async hops (e.g. XPromise).

## Out of Scope

- The `Header`/`ContextKey` type definitions themselves — those live in `core-util` (lowest-level package).
- HTTP header semantics or `PlatformHeader` implementations — belong in `http-api`.
- Generic utility/error helpers — belong in `core-util`.

## Notes (optional)

Depends only on Node built-ins plus the `Header` interface from `core-util`, deliberately keeping it below `http-api` to avoid circular dependencies. `put`/`setContext` throw if no context is active.
