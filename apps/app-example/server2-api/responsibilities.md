# Responsibilities — server2-api

Shared API contract for server2: the `Server2Api` abstract class (fetchValue) plus its request/response DTOs, annotated with webpieces routing/auth decorators. Implemented by `server2` and consumed by `client-server` as an HTTP client.

## In Scope

- `Server2Api` abstract class with `@ApiPath`/`@Endpoint`/`@Authentication`
- `FetchValueRequest`/`FetchValueResponse` DTOs shared across the hop
- The contract that makes client-server → server2 a real HTTP call

## Out of Scope

- Controller implementation / echo logic → `server2`
- Client binding and context transfer → `client-server`
- Company platform headers → `company-core`

## Notes (optional)

Contract-only library, no DI-registered classes. Same decorator pattern as `client-server-api`. DTO fields optional for protocol evolution.
