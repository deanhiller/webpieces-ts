# Responsibilities — mcp-server

Generate explicitly opted-in Webpieces API methods as authenticated MCP tools while preserving the
normal endpoint filter chain, DTO validation, and safe error boundary.

## In scope

- Convert `@WpMcpTool` API metadata and DTO metadata into MCP tool definitions.
- Validate resource-bound access tokens through an application verifier.
- Enforce explicit `@WpMcpAuthJwt` policy for the verified MCP user principal.
- Bind the application-selected MCP path through the official MCP 2026 HTTP/JSON-RPC implementation.
- Invoke local APIs through the ordinary proxy/filter chain with a fresh short-lived application JWT.
- Invoke remote APIs through generated Node clients using OIDC plus trusted delegated user context.
- Coordinate bounded list caches, request-scoped subscriptions, shutdown, and a pluggable event bus.
- Validate input/output DTO shapes and map every failure through the one `WpMcpErrorTranslator`
  (shared `ApiErrorBoundary` normalization, `ApiErrorCodec` text, requestId on every reply).

## Out of scope

- Application endpoint authorization: `@WpAuthJwt` / `@WpAuthOidc` and `AuthFilter` own the HTTP boundary.
- Issuing OAuth tokens: applications may use any authorization server, while this package describes
  the protected resource and verifies tokens at the resource boundary.
- Forwarding external MCP bearer tokens or browser JWTs to application endpoints.
- Durable/replayable event delivery; MCP list/resource notifications are cache invalidations.
