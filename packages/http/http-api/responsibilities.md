# Responsibilities — http-api

Shared HTTP API contract consumed by both client and server: REST decorators (ApiPath, Endpoint, Authentication), the HttpError hierarchy, datetime DTOs, platform-header registry/readers, ValidateImplementation, and the test-case recorder contract. Pure definitions, no runtime.

## In Scope

- API-definition decorators and their metadata readers (`ApiPath`, `Endpoint`, `Authentication`, `getEndpoints`, `getApiPath`, `METADATA_KEYS`)
- The typed HTTP error hierarchy (`HttpError`, `HttpNotFoundError`, `HttpBadRequestError`, etc.) and error-subtype constants shared across client and server
- Datetime DTOs/utilities (`InstantDto`, `DateDto`, `TimeDto`, `DateTimeDto` and their `*Util` helpers)
- Platform-header contract: `PlatformHeader`, `HeaderRegistry`, `WebpiecesCoreHeaders`, `ContextReader`, `HeaderMethods`
- Compile-time `ValidateImplementation` type checker ensuring controllers/clients match the API prototype
- Test-case recorder contract types (`TestCaseRecorder`, `RecordedEndpoint`, `DoNotRecord`, `RecordSerializer`) — interfaces only

## Out of Scope

- Server-side routing, `@Controller`, DI decorators → `http-routing`
- Generating actual HTTP requests from decorators → `http-client`
- The filter chain and `Filter` interface → `http-filters`
- Server runtime, Express wiring, recorder implementations → `http-server`

## Notes (optional)

This is the dependency root of the HTTP layer; it depends only on `@webpieces/core-util`. Both `http-routing` (server) and `http-client` (client) read the same decorator metadata defined here, keeping the request/response contract single-sourced.
