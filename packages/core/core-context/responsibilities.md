# Responsibilities — core-context

AsyncLocalStorage-based request-scoped context (a TypeScript port of Java webpieces' ThreadLocal Context/MDC). Exposes the RequestContext singleton to run(), get/put/remove/clear, and to capture/restore a whole scope (as an opaque `CapturedContext`) for work that leaves the request's async chain.

## In Scope

- The `RequestContext` singleton wrapping Node `AsyncLocalStorage` for request-scoped storage.
- `run()` to establish THE context at request start (nesting throws — one scope per request).
- Raw string accessors (`put`, `get`, `remove`, `has`) for the framework's own reserved, UNREGISTERED
  slots; they REJECT any name belonging to a registered `ContextKey`, so they cannot be used to read or
  forge a trusted value. Plus `clear` and `isActive`.
- Trust-typed accessors (`getTrusted`/`getUntrusted`/`putTrusted`/`putUntrusted`, plus `getAny` for
  framework serialization and `hasKey`/`removeKey`) keyed by a `ContextKey`. The verb states whether the
  value was PROVEN or merely asserted, and the wrong kind of key does not compile.
- `PendingWireTrust` — the holding pen for inbound wire values of TRUSTED keys, admitted or rejected by
  `AuthFilter` once the route's auth mode says whether the caller itself was verified.
- `CapturedContext` plus `copyContext()`/`restoreContext()`/`runWithContext()` for work whose async
  chain was BROKEN and re-rooted elsewhere (a queued job drained by a background loop, a batch flushed
  on a timer, an event listener fired from a socket the request does not own). AsyncLocalStorage
  follows `await` and callbacks by itself, so nothing else needs these. The snapshot is OPAQUE — its
  constructor is private and `copyContext()` is its only producer — so the restore side cannot be
  handed a hand-assembled map, which would forge whatever trusted values it contained.

## Out of Scope

- The `Header`/`ContextKey` type definitions themselves — those live in `core-util` (lowest-level package).
- HTTP header semantics or `PlatformHeader` implementations — belong in `http-api`.
- Generic utility/error helpers — belong in `core-util`.

## Notes (optional)

Depends only on Node built-ins plus the `Header` interface from `core-util`, deliberately keeping it below `http-api` to avoid circular dependencies. `put`/`restoreContext` throw if no context is active; `copyContext()` does not — it returns an empty snapshot.
