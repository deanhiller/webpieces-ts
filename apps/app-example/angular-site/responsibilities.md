# Responsibilities — angular-site

Angular single-page frontend demonstrating the webpieces browser client. It injects `SaveApi`/`PublicApi` as generated HTTP clients from `client-server-api` and calls the client-server service, wiring a HeaderRegistry from `company-core` for context header transfer.

## In Scope

- Angular app shell (components, routes, `app.config.ts`, bootstrap)
- Consuming `SaveApi`/`PublicApi` via generated browser HTTP clients
- `EnvironmentConfig` (API base URL) and browser-side header registration

## Out of Scope

- Server controllers / business logic → `client-server`
- API contract shapes and decorators → `client-server-api`
- Company header definitions → `company-core`

## Notes (optional)

Browser client uses the same contract classes and header definitions as the server, so the API is defined once and shared across server, Node, and browser.
