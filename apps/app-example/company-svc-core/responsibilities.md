# Responsibilities — company-svc-core

Company-wide shared SERVER core (node-only, `framework:express`). Holds the single shared server bootstrap and shared server DI so every express service starts the same way. It is the node-only counterpart to the browser-safe `company-core` and is NOT imported by Angular.

## In Scope

- `bootstrapServer(meta, options)` — the one startup sequence every service uses: install the server log backend, build `WebpiecesConfig`, `WebpiecesFactory.create(meta)`, `server.start(port)`, park on SIGTERM/SIGINT, and log+exit(1) on startup error.
- `BootstrapOptions` — the per-service inputs (port, logger name, and the `LoggerFactory` seam where a node-only backend like bunyan/winston/pino is plugged in).
- `CompanyHeadersModule` — the shared company-header DI binding (`PlatformHeadersExtension` of `CompanyHeaders`), previously copy-pasted per service.

## Out of Scope

- Browser-safe shared code (company headers definitions, browser console logging bootstrap) — lives in `company-core` (`framework:all`), which Angular imports.
- The HTTP runtime itself (Express, CORS, middleware, route mounting, filter chains) — lives in `@webpieces/http-server`; `bootstrapServer` only orchestrates it.
- App-specific DI (a service's own controllers, clients, app headers) and each service's `WebAppMeta` — stay per-service.
- The logging interface and default console backend — live in `@webpieces/wp-logging`.

## Notes (optional)

Tagged `framework:express` (node/server-only) so under the `library-types-match-client` rule it may depend on server-only libs (`http-server`) as well as `all` libs (`company-core`, `http-routing`, `http-api`, `wp-logging`); it must never be imported by an `angular`/`all` project.
