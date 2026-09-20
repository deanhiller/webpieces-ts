# Responsibilities — http-server

Server runtime that assembles the HTTP layer: bootstraps the Inversify DI container, builds routes/filter chains from `WebAppMeta`, serves them over Express, ships built-in filters (Context, LogApi, Recording, ServiceAuth), the in-process test client, and the test-case recorder.

## In Scope

- Server bootstrap and lifecycle (`WebpiecesServer`, `WebpiecesFactory`, `WebpiecesServerImpl`)
- Express integration and request dispatch (`WebpiecesMiddleware`, `WebpiecesRouteCreator`, CORS), including symmetric path/query/body binding for GET, JSON POST, and form POST plus complete `HttpResponseDto` status/header/body emission
- Obtaining request body bytes (`RequestBodyReader`: `StreamBodyReader` default, opt-in `PreConsumedBodyReader` for hosts such as Cloud Functions gen2 that consume the stream first and keep `req.rawBody`), chosen via `WebpiecesExpressRouter.setBodyReader`
- DI container/module wiring (`WebpiecesModule`) binding framework singletons
- Built-in concrete filters: `ContextFilter`, `LogApiFilter`, `RecordingFilter`, `ServiceAuthFilter` (service-to-service `@WpAuthOidc`/`@WpAuthSharedSecret` enforcement on Cloud Tasks / cross-service delivery)
- In-process (HTTP-less) client factory for tests (`InProcessApiClientFactory`)
- Writing the error response: `ExpressWrapper.handleError` narrows the thrown value once and makes ONE unconditional call to `ClientRegistry.getErrorTranslator().toWire(error)`. The classification itself belongs to core-util's `WebpiecesDefaultErrorTranslator` (always installed; an app translator REPLACES it and declines by delegating to it). Only `ApiEndUserError.message` is directly caller-facing; `ApiBadRequestError.callerMessage` is the explicit safe validation field. Every other message is generic and the operator diagnostic stays in logs.
- Republishing an end-user answer at the status THIS CALLER expects, from `WebpiecesCoreHeaders.SURFACE` (`SurfaceEndUserStatus`): 266 for `gui`, `llm` and an unidentified caller; `edgeHttpStatus` (400 when absent) for `public-api`. Per REQUEST, not per router — `setEndUserStatus` is gone.
- Test-case recorder implementation and spec generation (`TestCaseRecorderImpl`, `SpecGenerator`, `recordable`)

## Out of Scope

- Route/filter registration data structures and matching → `http-routing`
- The `Filter` / `Service` / `FilterChain` abstraction → `core-util`; the inbound chain's `WpResponse`, `FilterMatcher` and `FilterDefinition` → `http-routing`
- API decorators, error types, recorder contract → `http-api`
- Client-side (browser) HTTP request generation → `http-client`

## Notes (optional)

Top of the HTTP dependency stack (depends on `http-routing`, transitively on `core-util`). This is where abstract routing/filter metadata becomes a running Express server with a live DI container. Concrete server filters live here; the `Filter` abstraction they extend lives in `core-util`, shared with the client's outbound chain.
