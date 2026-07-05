# Responsibilities — client-server-api

Shared API contract for the client-server service: `SaveApi`/`PublicApi` abstract classes plus request/response DTOs, annotated with webpieces routing/auth decorators. Single source of truth implemented server-side and consumed by browser clients.

## In Scope

- Abstract API classes (`SaveApi`, `PublicApi`) decorated with `@ApiPath`, `@Endpoint`, `@Authentication`
- Request/response DTO interfaces shared between server and clients
- The contract that `client-server` implements and `angular-site` calls via generated clients

## Out of Scope

- Controller implementations / business logic → `client-server`
- HTTP client wiring, DI modules, server bootstrap → `client-server`
- Company platform headers → `company-core`
- The server2 contract → `server2-api`

## Notes (optional)

Contract-only library: no DI-registered classes. Decorators are read both server-side (route binding) and client-side (`createApiClient`). DTO fields are optional for protocol evolution.
