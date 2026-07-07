# Responsibilities — company-core

Company-wide shared core library, browser-safe, brought in by ALL example projects. Defines the second-tier `CompanyHeaders` (tenant id, api version) as `PlatformHeader` constants that servers bind and browsers register — the company layer between framework core headers and app headers.

## In Scope

- `CompanyHeaders` platform-header constants shared across every app
- Company-wide, cross-cutting definitions safe for both server and browser

## Out of Scope

- Framework core headers → provided by `@webpieces/core-util`
- App-specific headers, controllers, DI wiring → `client-server`/`server2`
- API contracts/DTOs → `*-api` modules (which do NOT depend on company-core)

## Notes (optional)

Three-tier header system: WebpiecesCoreHeaders → CompanyHeaders → AppHeaders. Api packages deliberately do not know about these; servers bind them and the Angular client builds a HeaderRegistry from the same class.
