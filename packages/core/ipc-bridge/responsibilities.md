# Responsibilities — ipc-bridge

Provides portable typed client proxies and server dispatch from one public package for duplex IPC in browser, React Native, and Node.

## In Scope

- Client factories, stable method dispatch, and safe proxy inspection.
- Multiple explicit API registrations on one dispatcher and duplicate detection.
- Request/reply validation, acknowledged void, and canonical exception translation.
- Per-call logging and explicit correlation, including scoped controller construction.
- Duplex JSON-crossing regression tests using both exported factories together.

## Out of Scope

- Shared envelopes, schemas, connections, and errors belong to core-util's portable subpaths.
- DI containers, HTTP servers, platform adapters, WebView trust, application reporting, and native lifecycle behavior belong to the host.
