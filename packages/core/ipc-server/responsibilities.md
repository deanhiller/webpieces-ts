# Responsibilities — ipc-server

Hosts typed IPC receiver implementations behind one shared connection dispatcher. It validates DTOs, invokes registered methods with scoped context, logs outcomes, and encodes canonical failure replies for generated clients.

## In Scope

- Multiple explicit API registrations on one dispatcher and duplicate detection.
- Request/reply schemas, acknowledged void, and exception translation.
- Manually injected implementations and per-call controller construction.

## Out of Scope

- Client proxies belong to ipc-client; protocol and connection lifetime belong to core-util.
- DI containers, HTTP servers, vendor bus internals, WebView origin validation, and application Sentry policy belong to the host.
