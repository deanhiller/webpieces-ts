# Responsibilities — server2

Runnable downstream example service (port 8202) implementing the `server2-api` contract. Server2Controller echoes received magic-context headers (request-id chain, previous-id, tenant) back in its response so callers and the e2e test can prove end-to-end context transfer.

## In Scope

- `Server2Controller` implementing `Server2Api.fetchValue`
- Server bootstrap (`server.ts`, `Server2Meta`), DI module, filter routes
- Reading/echoing framework and company context headers per hop

## Out of Scope

- The server2 contract shapes/decorators → `server2-api`
- The calling service and outbound client → `client-server`
- Company header definitions → `company-core`
- Two-server flow tests → `app-example-e2e`

## Notes (optional)

Exists to make the client-server → server2 call a genuine second HTTP hop, exercising per-hop request-id chaining and context header propagation.
