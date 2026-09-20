# Responsibilities — mcp-server

Generate explicitly opted-in Webpieces API methods as authenticated MCP tools while preserving the
normal endpoint filter chain, DTO validation, and safe error boundary.

## In scope

- Convert `@WpMcpTool` API metadata and DTO metadata into MCP tool definitions.
- Validate resource-bound access tokens through an application verifier.
- Enforce explicit `@WpMcpAuthJwt` policy for the verified MCP user principal.
- Bind the application-selected MCP path through the official MCP v2 HTTP/JSON-RPC implementation,
  serving both the 2026-07-28 and the 2025-era wire from one registry (the revision is negotiated).
- Invoke local APIs through the ordinary proxy/filter chain with a fresh short-lived application JWT.
- Invoke remote APIs through generated Node clients using OIDC plus trusted delegated user context.
- Coordinate bounded list caches, request-scoped subscriptions, shutdown, and a pluggable event bus.
- Validate input/output DTO shapes and map every failure through the one `WpMcpErrorTranslator`,
  which has one method per boundary — `toBearerBoundaryResponse`, `toListError`, `toToolCallResult`
  (shared `ApiErrorBoundary.encode` classification and published text, requestId on every reply).
- Let an application's `McpErrorTranslator`, registered on the process-global `McpRegistry`, REPLACE
  the webpieces `tools/call` rendering (declining by delegating to `McpDefaultToolCallRenderer`), and
  own the reply for `tools/list` and the pre-SDK HTTP boundary outright. The registry is never empty,
  so `toToolCallResult` makes ONE unconditional call — the same shape `ClientRegistry` gives HTTP and
  `IpcRegistry` gives IPC.
- Have `toWire` and NO `fromWire`: webpieces is never the MCP client, so there is no return path to
  translate. Documented on `McpErrorTranslator` so it does not read as an oversight.
- Keep the pre-SDK boundary OFF the HTTP `ErrorTranslator` even though both return `HttpResponseDto`:
  its body must stay JSON-RPC shaped or the `401 + WWW-Authenticate` OAuth discovery signal breaks.
- Wrap the edges with no filter chain above them — bearer, `Origin`, body, `tools/list` — in
  `LogApiCall`, so every failure gets exactly one operator line and the error boundary writes none.

## Out of scope

- Operator logging of a failure the filter chain already logged: `LogApiFilter` / `LogApiCall` owns
  that line, and a second bare one at the protocol edge is the defect `ErrorLogFilter` was deleted for.

- Application endpoint authorization: `@WpAuthJwt` / `@WpAuthOidc` and `AuthFilter` own the HTTP boundary.
- Issuing OAuth tokens: applications may use any authorization server, while this package describes
  the protected resource and verifies tokens at the resource boundary.
- Forwarding external MCP bearer tokens or browser JWTs to application endpoints.
- Durable/replayable event delivery; MCP list/resource notifications are cache invalidations.
