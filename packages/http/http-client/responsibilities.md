# Responsibilities — http-client

Client-side counterpart to http-routing: reads http-api decorators to generate type-safe HTTP clients from an API interface (`createApiClient`/`ClientConfig`), propagates request context/platform headers, chains request IDs, and translates HTTP error responses back into typed errors.

## In Scope

- Proxy-based client generation from API decorators (`createApiClient`, `ClientConfig`)
- Outbound header/context propagation (`ContextMgr`, `MutableContextStore`, `StaticContextReader`, `CompositeContextReader`)
- Request-ID chaining across calls (`RequestIdChainProcessor`)
- Translating HTTP responses/status codes into the typed `HttpError` hierarchy (`ClientErrorTranslator`)
- Convenience re-exports of the http-api header contract and API decorators for one-import browser use

## Out of Scope

- Defining the API decorators and error types themselves → `http-api`
- Server-side routing to controllers → `http-routing`
- Running a server or building filter chains → `http-server`
- The in-process (no-HTTP) client used for tests → `InProcessApiClientFactory` in `http-server`

## Notes (optional)

Depends only on `@webpieces/http-api` (no server deps), so it stays browser-safe. It is the "contract → HTTP request" direction; `http-routing` is the mirror "contract → handler" direction.
