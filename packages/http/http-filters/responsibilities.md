# Responsibilities — http-filters

Minimal filter-chain primitives for cross-cutting concerns: the `Filter`/`Service` interfaces, the `WpResponse` type, and `FilterChain`, which invokes filters in order and wraps the terminal controller call. Pure infrastructure with no concrete filters.

## In Scope

- The `Filter` interface (the `filter(meta, next)` contract) and `Service` abstraction
- `FilterChain` execution — running filters in priority order and delegating to the next link/controller
- The shared `WpResponse` response type used by the chain

## Out of Scope

- Matching filters to routes by filepath/pattern → `FilterMatcher` in `http-routing`
- `FilterDefinition`/`RouteBuilder` registration types → `http-routing`
- Concrete filter implementations (`ContextFilter`, `LogApiFilter`, `RecordingFilter`) → `http-server`
- HTTP errors, decorators, and `MethodMeta` → `http-api` / `http-routing`

## Notes (optional)

Depends only on `@webpieces/core-context` so it can carry request-scoped context through the chain without pulling in routing or server code. Deliberately tiny — it defines the contract every filter honors, not the filters themselves.
