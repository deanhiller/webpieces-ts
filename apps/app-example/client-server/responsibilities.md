# Responsibilities — client-server

Runnable example webpieces service (port 8200) implementing the `client-server-api` contract (SaveController, PublicController). It also acts as a client that calls `server2` over real HTTP, demonstrating DI modules, filters, and magic-context header transfer.

## In Scope

- Controllers implementing `SaveApi`/`PublicApi` (business logic)
- Server bootstrap (`server.ts`, `ProdServerMeta`), DI modules, filters, routes
- Outbound `Server2Api` HTTP client binding (and test simulator/mock)
- App-specific header wiring and auth filter

## Out of Scope

- The API contract shapes/decorators → `client-server-api`
- The server2 contract → `server2-api`; server2's implementation → `server2`
- Company-wide headers → `company-core`
- Cross-service end-to-end tests → `app-example-e2e`

## Notes (optional)

Three-tier DI module order (Webpieces → Company → app). `Server2Api` is a real HTTP hop in prod but rebound to a simulator/mock in tests.
