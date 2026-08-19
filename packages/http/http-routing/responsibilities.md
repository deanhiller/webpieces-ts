# Responsibilities — http-routing

Server-side routing layer: `@Controller`/DI decorators, `WebAppMeta`/`Routes`/`RouteBuilder` wiring, `RouteDefinition`/`FilterDefinition`, `MethodMeta`, `FilterMatcher` (glob-based filter-to-route matching), and `ApiRoutingFactory` that maps http-api decorators to controller handlers.

## In Scope

- Server routing decorators: `Controller`, `NotController`, and Inversify helpers `provideSingleton`/`provideSingletonDefaultForApi`/`provideTransient`
- Route/app metadata contracts: `WebAppMeta`, `Routes`, `RouteBuilder`, `RouteDefinition`, `FilterDefinition`, `RouteBuilderImpl`
- Turning API decorators into invokable routes (`ApiRoutingFactory`, `RouteHandler`, `MethodMeta`) — including SKIPPING an `@AuthLocalOnly` route entirely when `RuntimeLocality` says this process is not a developer machine, so the endpoint does not exist off-local
- Enforcing every auth mode at request time (`AuthFilter`: `@Public`, `@AuthJwt`, `@AuthOidc`, `@AuthSharedSecret`, `@AuthWebhook`, `@AuthApiKey`, `@AuthLocalOnly`), and declaring the process's locality at startup from `RuntimeSetupOptions.locality`
- The four app-implemented auth seams (`JwtHook`, `OidcHook`, `WebhookAuthCallback`, `ApiKeyHook`) and their optional DI tokens — bind one to turn on the endpoints that need it; unbound means 401, never open. Every method on all four is ASYNC, because an app's verification strategy reaches the network, and all four share ONE shape: `verify<Thing>`/`parseJwt` takes the credential regime plus what it needs to read it, and every AUTHENTICATING one returns an `AuthenticatedCaller` (`parseJwt`, `verifyApiKey`, `verifyWebhook`). `verifyOidc` returns `void` — it is caller-VERIFIED and has a framework default (`DefaultOidcVerifier`)
- The `AuthenticatedCaller` an authenticator proved (userId, roles, claims, the trusted `entries` to seed) and `AUTHENTICATED_CALLER_KEY`, the trusted `ContextKey` the `AuthFilter` stamps it under
- Matching filters to routes by controller filepath glob (`FilterMatcher`, `minimatch`)
- Request-scoped context reading and server config types (`RequestContextReader`, `WebpiecesConfig`)

## Out of Scope

- The `Filter` interface and `FilterChain` execution engine → `http-filters`
- Actually starting/serving over Express, DI container bootstrap → `http-server`
- API decorators/errors/`ValidateImplementation` definitions → `http-api` (re-exported here for convenience)
- Client-side request generation → `http-client`

## Notes (optional)

Depends on `http-api`, `http-filters`, `inversify`, and `minimatch`. This is the "contract → handler" direction. It defines routing/filter-registration data structures and matching logic but does not run a server — `http-server` consumes this to build and serve the app.
