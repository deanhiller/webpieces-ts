# Responsibilities — http-server

Server runtime that assembles the HTTP layer: bootstraps the Inversify DI container, builds routes/filter chains from `WebAppMeta`, serves them over Express, ships built-in filters (Context, LogApi, Recording, ServiceAuth), the in-process test client, and the test-case recorder.

## In Scope

- Server bootstrap and lifecycle (`WebpiecesServer`, `WebpiecesFactory`, `WebpiecesServerImpl`)
- Express integration and request dispatch (`WebpiecesMiddleware`, `WebpiecesRouteCreator`, CORS)
- DI container/module wiring (`WebpiecesModule`) binding framework singletons
- Built-in concrete filters: `ContextFilter`, `LogApiFilter`, `RecordingFilter`, `ServiceAuthFilter` (service-to-service `@AuthOidc`/`@AuthSharedSecret` enforcement on Cloud Tasks / cross-service delivery)
- In-process (HTTP-less) client factory for tests (`InProcessApiClientFactory`)
- Deciding what an outside caller may see of a thrown `HttpError` (`HttpErrorWireMapper`, driven by `ExpressWrapper.handleError`). ONLY `HttpUserError`'s `message` goes on the wire — it is the one type written for a human to read. Every other subclass sends the generic HTTP reason phrase for its status and logs the real message, because `Error.message` is an operator field that routinely quotes downstream urls, response bodies and internal ids. Structured contract data (`errorCode`, `waitSeconds`, `subType`, `field`, `guiAlertMessage`) still goes out; `name` does not. The opt-out is an app-registered `ClientRegistry` error translation, whose `toWire()` result is sent verbatim
- Test-case recorder implementation and spec generation (`TestCaseRecorderImpl`, `SpecGenerator`, `recordable`)

## Out of Scope

- Route/filter registration data structures and matching → `http-routing`
- The `Filter` / `Service` / `FilterChain` abstraction → `core-util`; the inbound chain's `WpResponse`, `FilterMatcher` and `FilterDefinition` → `http-routing`
- API decorators, error types, recorder contract → `http-api`
- Client-side (browser) HTTP request generation → `http-client`

## Notes (optional)

Top of the HTTP dependency stack (depends on `http-routing`, transitively on `core-util`). This is where abstract routing/filter metadata becomes a running Express server with a live DI container. Concrete server filters live here; the `Filter` abstraction they extend lives in `core-util`, shared with the client's outbound chain.
