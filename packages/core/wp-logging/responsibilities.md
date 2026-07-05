# Responsibilities — wp-logging

Pluggable logging interface for WebPieces, usable in browser (Angular/React) and Node.js. Ships the `Logger`/`LoggerFactory` interfaces, a browser-safe console default, and the slf4j-style `LogManager` holder, so code logs through one seam while each app plugs in its own backend at startup.

## In Scope

- The `Logger` interface (`trace/debug/info/warn/error`) and `LogLevel` union — the logging contract every call site depends on.
- The `LoggerFactory` interface (`getLogger(name)`) — the seam an app implements to choose a backend.
- `ConsoleLogger` / `ConsoleLoggerFactory` — the default browser-safe implementation backed by `console.*`.
- `LogManager` — the global static holder: `getLogger(name)` for call sites, `setFactory(factory)` for app startup wiring.
- Staying zero-dependency and browser-safe (no `async_hooks`, `fs`, or backend libraries imported here).

## Out of Scope

- Concrete node-only backends (bunyan/winston/pino adapters, file/`server.log` writers) — installed by `framework:express` apps via `LogManager.setFactory`, never here.
- Request-scoped context / MDC storage — lives in `core-context` (Node) and is read via the header/context abstractions in `http-api`; this package must not import those to stay at the base of the hierarchy.
- HTTP request/response log formatting (the `[API-*]` lines) — owned by `LogApiCall` in `http-api`, which merely calls this package.
- Choosing log levels or masking secure values — a backend/caller concern.

## Notes (optional)

Sits alongside `core-util`/`core-context` at the base of the dependency hierarchy. It is `framework:all`, so under the `library-types-match-client` rule it may only depend on other `all` libraries and must never pull in a side-specific (node/browser-only) backend.
