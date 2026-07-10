# Responsibilities — http-routing

Server-side routing layer: `@Controller`/DI decorators, `WebAppMeta`/`Routes`/`RouteBuilder` wiring, `RouteDefinition`/`FilterDefinition`, `MethodMeta`, `FilterMatcher` (glob-based filter-to-route matching), and `ApiRoutingFactory` that maps http-api decorators to controller handlers.

## In Scope

- Server routing decorators: `Controller`, `NotController`, and Inversify helpers `provideSingleton`/`DefaultImplementationOn`/`provideTransient`
- Route/app metadata contracts: `WebAppMeta`, `Routes`, `RouteBuilder`, `RouteDefinition`, `FilterDefinition`, `RouteBuilderImpl`
- Turning API decorators into invokable routes (`ApiRoutingFactory`, `RouteHandler`, `MethodMeta`)
- Matching filters to routes by controller filepath glob (`FilterMatcher`, `minimatch`)
- Request-scoped context reading and server config types (`RequestContextReader`, `WebpiecesConfig`)

## Out of Scope

- The `Filter` interface and `FilterChain` execution engine → `http-filters`
- Actually starting/serving over Express, DI container bootstrap → `http-server`
- API decorators/errors/`ValidateImplementation` definitions → `http-api` (re-exported here for convenience)
- Client-side request generation → `http-client`

## Notes (optional)

Depends on `http-api`, `http-filters`, `inversify`, and `minimatch`. This is the "contract → handler" direction. It defines routing/filter-registration data structures and matching logic but does not run a server — `http-server` consumes this to build and serve the app.
