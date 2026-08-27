# Responsibilities — http-client-node

The server-side HTTP client: generates type-safe clients from the SAME API contract the callee's controller implements. Node-only, so it is fully inversify-wired, reads the magic context straight out of the `RequestContext`, and mints its own delivery auth.

## In Scope

- `ClientHttpFactory` — the `@DocumentDesign` design root and inversify entry point; one per service, injected wherever a typed client is needed
- `NodeProxyClient` — the container-wired `ProxyClient` (bound TRANSIENT: each API contract needs its own), plus `ProxyClientProvider`, the Guice-style `Provider<T>` that hands out a fresh one per `createRpcClient`
- `ClientConfig` — per-client state: the callee's `svcName` (typically its Cloud Run service name) AND its `HostPolicy`, which is required. Non-derivable URLs (localhost, cross-region/project, non-Cloud-Run) come from a `ClientRegistry` mapping, not a per-client override
- `HostPolicy` and its three concrete answers to "where do this client's requests go" — `DeployedServiceHost` (a service we deploy, resolved through `ClientRegistry`; installs no filters and is byte-for-byte the previous behaviour), `RuntimeHostFromContext` (the base URL arrives per call from `WebpiecesCoreHeaders.OVERRIDE_BASE_URL`, for a partner-registered webhook URL / OAuth callback / per-tenant host), and `RuntimeHostFromContextAllowingInternalAddresses` (the same, with the SSRF refusals off and a required `reason`). The choice is a NAMED class at the construction site so `grep -rn RuntimeHostFromContext` enumerates every client that can be re-pointed at all
- Owning SSRF for a destination that is attacker-influenced data: `SsrfGuardFilter` + `SsrfPolicy` + `InternalAddressRules` + `AddressResolver`. https-only by default; loopback / RFC1918 / CGNAT / link-local / cloud-metadata refused by NAME and by every address the name resolves to (one private answer among several condemns the request, so DNS rebinding is a refusal); redirects taken away from the transport and re-judged hop by hop, capped. It raises the cost of the attack and does NOT claim to close the resolve-then-connect TOCTOU window — egress firewalling remains the control that cannot be tricked
- `ContextBaseUrlOverrideFilter` — the built-in outbound filter that carries the per-call destination from the ambient `RequestContext` into the send path. It mutates only the per-call `ClientRequest`, so an override never leaks to the next call and never touches the client
- Refusing, at BIND time, an `@AuthOidc` / `@AuthSharedSecret` endpoint on a runtime-host client: both mint a credential for a peer WE chose, and a destination that arrives per call has no honest audience
- Owning a downstream 4xx as THIS server's 500 (`NodeProxyClient.adaptDownstreamFailure`). A status from a dependency describes OUR request to it — a wrong path, a wrong base URL, an undeployed dependency, bad service credentials — so relaying it would let an internal misconfiguration impersonate a legitimate answer to an external consumer. The downstream diagnostic survives as the 500's `httpCause` — in full when the answer came from something that is NOT a webpieces server (an lb's html 404, a proxy's plain-text 502), because `ResponseBodyReader` synthesizes that text client-side; from a webpieces PEER it is the generic reason phrase for the status, since that peer deliberately publishes nothing more (see `HttpErrorWireMapper` in `http-server`) and its real message lives in its own log, correlated by request id. 5xx / 598 pass through; the opt-out is an app-registered `ClientRegistry` error translation, not a config flag
- Failing fast when a call is made outside `RequestContext.run(...)` — an outbound call with no correlation id or request-id chain is a bug, not a default

## Out of Scope

- The decorator-reading engine, the Proxy trap, and the status→type mapping itself → `http-client-core`
- Resolving `svcName` → base URL → `ClientRegistry.resolve` in core-util (mapping, else the installed deriver, else throw). The GCP deriver and OIDC minting → `gcp-identity` (`gcpCloudRunDeriver`, `mintIdToken`)
- Reading/propagating the magic context → `RequestContextHeaders` in `core-context`
- Enqueuing fire-and-forget work → `cloudtasks-client`, its structural twin
- Server-side routing to controllers → `http-routing`
- The outbound filter CHAIN itself (`ClientRequest`, `ClientFilterDefinition`, the execution) → `http-client-core`; the `Filter` / `Service` / `FilterChain` abstraction under it → `core-util`

## Notes

Node-only, so unlike `http-client-browser` there is no `ContextReader` indirection: a server has exactly one right answer, and the seam only hid the missing-context failure. `Secrets` is `@optional` — only `@AuthSharedSecret` endpoints need it. Because `NodeProxyClient` is transient, the generated design graph draws it as a stack of boxes: every `provider.get()` resolves its own instance.
