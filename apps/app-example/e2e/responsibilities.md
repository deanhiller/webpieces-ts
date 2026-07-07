# Responsibilities — app-example-e2e

End-to-end test project for the two-service example. Boots both `client-server` and `server2` on test ports with real HTTP between them and asserts the magic context (correlation/transaction id, per-hop request-id chain, tenant) flows through both servers' logs, with secured headers masked.

## In Scope

- Full-flow tests booting real client-server + server2 instances
- Verifying end-to-end context propagation, per-hop id chaining, header masking
- Cross-service integration assertions spanning both apps

## Out of Scope

- Single-service unit/integration tests → each service's own `src/test`
- Controller or client implementation → `client-server`/`server2`
- API contracts → `*-api` modules

## Notes (optional)

Uses ports 18200/18202 to avoid clashing with dev servers (8200/8202). Both servers run in one test process; log capture proves context logging works across the HTTP hop.
