# Responsibilities — mcp-server

## In scope

- Convert `@WpMcpTool` API metadata and DTO metadata into MCP tool definitions.
- Validate resource-bound access tokens through an application verifier.
- Invoke the existing API proxy/filter chain with the verified endpoint bearer credential.
- Validate input/output DTO shapes and sanitize tool errors through `ApiErrorCodec`.

## Out of scope

- Authorization policy: existing `@WpAuthJwt` / `@WpAuthPublic` metadata and `AuthFilter` own it.
- Issuing OAuth tokens: applications may use any authorization server, while this package describes
  the protected resource and verifies tokens at the resource boundary.
- Forwarding MCP bearer tokens or stamping trusted request context.
