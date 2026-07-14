# Responsibilities — http-client-node

The server-side HTTP client: generates type-safe clients from the SAME API contract the callee's controller implements. Node-only, so it is fully inversify-wired, reads the magic context straight out of the `RequestContext`, and mints its own delivery auth.

## In Scope

- `ClientHttpFactory` — the `@DocumentDesign` design root and inversify entry point; one per service, injected wherever a typed client is needed
- `NodeProxyClient` — the container-wired `ProxyClient` (bound TRANSIENT: each API contract needs its own), plus `ProxyClientProvider`, the Guice-style `Provider<T>` that hands out a fresh one per `createRpcClient`
- `ClientConfig` — per-client state: the callee's `svcName` (typically its Cloud Run service name). Non-derivable URLs (localhost, cross-region/project, non-Cloud-Run) come from a `ClientRegistry` mapping, not a per-client override
- Failing fast when a call is made outside `RequestContext.run(...)` — an outbound call with no correlation id or request-id chain is a bug, not a default

## Out of Scope

- The decorator-reading engine, the Proxy trap, and error translation → `http-client-core`
- Resolving `svcName` → base URL → `ClientRegistry.resolve` in core-util (mapping, else the installed deriver, else throw). The GCP deriver and OIDC minting → `gcp-identity` (`gcpCloudRunDeriver`, `mintIdToken`)
- Reading/propagating the magic context → `RequestContextHeaders` in `core-context`
- Enqueuing fire-and-forget work → `cloudtasks-client`, its structural twin
- Server-side routing to controllers → `http-routing`

## Notes

Node-only, so unlike `http-client-browser` there is no `ContextReader` indirection: a server has exactly one right answer, and the seam only hid the missing-context failure. `Secrets` is `@optional` — only `@AuthSharedSecret` endpoints need it. Because `NodeProxyClient` is transient, the generated design graph draws it as a stack of boxes: every `provider.get()` resolves its own instance.
