# Responsibilities — legacy-server

Example of INCREMENTAL webpieces adoption: a pre-existing express app (own routes, untouched) with the webpieces api → filters → controller pipeline bolted on via `WebpiecesRouteCreator`, using the SAME shared `setupCompanyRuntime` startup as the greenfield server. Proven by an integration test.

## In Scope

- Demonstrating `WebpiecesRouteCreator` mounted onto a caller-owned express app
- Showing the shared `setupCompanyRuntime` (headers → logging → router+container) reused for the legacy path via `router.getContainer()`
- Integration test asserting legacy-route coexistence, filter priority + glob scoping, auth/error mapping, and the in-process client

## Out of Scope

- New business logic / controllers → reuses `client-server`'s controllers, filters, API contracts
- The full-server (webpieces-owns-express) path → `client-server` / `server2` via `bootstrapServer`
- API contracts → `*-api` modules

## Notes (optional)

Test-only project (like `app-example-e2e`): the example boot code lives in `src/LegacyServer.ts` and is exercised by `src/test`. The key point is that the legacy adapter no longer hand-rolls its DI container — it reuses the exact container `setupCompanyRuntime` builds, so embedded routes resolve identically to production.
