# Responsibilities — http-server

Server runtime that assembles the HTTP layer: bootstraps the Inversify DI container, builds routes/filter chains from `WebAppMeta`, serves them over Express middleware, ships built-in filters (Context, LogApi, Recording), the in-process test client, and the test-case recorder implementation.

## In Scope

- Server bootstrap and lifecycle (`WebpiecesServer`, `WebpiecesFactory`, `WebpiecesServerImpl`)
- Express integration and request dispatch (`WebpiecesMiddleware`, `WebpiecesRouteCreator`, CORS)
- DI container/module wiring (`WebpiecesModule`) binding framework singletons
- Built-in concrete filters: `ContextFilter`, `LogApiFilter`, `RecordingFilter`
- In-process (HTTP-less) client factory for tests (`InProcessApiClientFactory`)
- Test-case recorder implementation and spec generation (`TestCaseRecorderImpl`, `SpecGenerator`, `recordable`)

## Out of Scope

- Route/filter registration data structures and matching → `http-routing`
- The `Filter` interface and chain engine → `http-filters`
- API decorators, error types, recorder contract → `http-api`
- Client-side (browser) HTTP request generation → `http-client`

## Notes (optional)

Top of the HTTP dependency stack (depends on `http-routing`, transitively on `http-filters`/`http-api`). This is where abstract routing/filter metadata becomes a running Express server with a live DI container. Concrete filters live here, not in `http-filters`, which holds only the contract.
