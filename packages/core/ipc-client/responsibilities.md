# Responsibilities — ipc-client

Creates portable typed IPC clients from shared API metadata. It validates request and reply DTOs, reconstructs canonical failures, and preserves per-call logging and correlation across browser, React Native, and Node.

## In Scope

- Client factories, stable method dispatch, and safe proxy inspection.
- Reply decoding inside the client logging span, including acknowledged void.
- Explicit nested-call context and JSON-crossing regression tests.

## Out of Scope

- Shared envelopes, schemas, connections, and errors belong to core-util's portable subpaths.
- Receiver dispatch belongs to ipc-server.
- WebView trust, platform adapters, application reporting, and native lifecycle behavior belong to the host.
