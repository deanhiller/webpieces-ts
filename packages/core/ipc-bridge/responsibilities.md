# Responsibilities — ipc-bridge

Provides portable typed client proxies and server dispatch from one public package for duplex IPC in browser, React Native, and Node.

## In Scope

- Client factories, stable method dispatch, and safe proxy inspection.
- Multiple explicit API registrations on one dispatcher and duplicate detection.
- Request/reply validation, acknowledged void, and canonical exception translation through the ONE
  app-reachable seam: `IpcRegistry.getErrorTranslator()`. The receiver calls `toWire` in its catch,
  the client calls `fromWire` for EVERY reply (success included) via `IpcClientErrorTranslator`, and
  the webpieces default applies the same uniform received-error rule HTTP does — a caller-error kind
  coming back is MY bug, a server-side kind is the PEER broken, an `ApiDependencyError` passes
  through. Neither half has a "was one registered" branch.
- Per-call logging and explicit correlation, including scoped controller construction.
- Duplex JSON-crossing regression tests using both exported factories together.

## Out of Scope

- Shared envelopes, schemas, connections, and errors belong to core-util's portable subpaths.
- DI containers, HTTP servers, platform adapters, WebView trust, application reporting, and native lifecycle behavior belong to the host.
