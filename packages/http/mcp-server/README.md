# @webpieces/mcp-server

Publishes explicitly annotated Webpieces RPC endpoints as MCP tools. The bridge generates input and
output JSON Schema from DTO metadata, invokes the normal Webpieces filter/controller path, and turns
exceptions into safe model-visible MCP results.

`@WpMcpTool` is an opt-in. Existing endpoint authentication remains authoritative on every call.
The MCP adapter never accepts trusted context values from tool arguments or headers.

```ts
@WpDto()
class FindOrderRequest {
    @WpDtoField(new WpDtoFieldOptions('Order identifier', true))
    orderId!: string;
}

@WpDto()
class FindOrderResponse {
    @WpDtoField(new WpDtoFieldOptions('Current order state', true))
    state!: string;
}

@ApiPath('/orders')
abstract class OrdersApi {
    @WpAuthJwt({ allRolesAllowed: true })
    @Endpoint('/find', 'rpc')
    @WpResponseDto(() => FindOrderResponse)
    @WpMcpTool({
        name: 'orders_find',
        description: 'Find one order owned by the signed-in user.',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
    })
    find(request: FindOrderRequest): Promise<FindOrderResponse> {
        throw new Error('contract only');
    }
}
```

The `@WpMcpTool.description` becomes the tool description returned by `tools/list`. The request and
response classes generate `inputSchema` and `outputSchema`; `@WpDtoField` supplies property
descriptions and the facts TypeScript erases, such as optionality and array element types.

Applications construct `WpMcpServer` with their built `ApiFactory`, the API classes they want scanned,
a paired `McpAccessTokenAuthority`, and their application `JwtHook`. The authority verifies issuer,
signature/token state, expiry, scopes, the exact resource URI, and current account state on every MCP
operation. Before every tool call the bridge asks the same application `JwtHook` to mint a distinct,
short-lived endpoint JWT, then invokes the ordinary `AuthFilter`. Literal MCP-token passthrough is
rejected, endpoint JWTs are capped at one hour, and MCP access tokens are capped at 30 days.

The verifier's `accountValidatedAtEpochSeconds` must represent an authoritative enabled/revoked and
role/scope read. The bridge enforces a maximum one-hour decision age; per-request reads are preferred so
offboarding and role changes take effect on the next call. JWT access-token implementations must enforce
an explicit algorithm allowlist plus issuer, exact audience/resource, expiry, type/version, and key
rotation metadata. Opaque tokens remain valid implementations of the same authority contract.

`protectedResourceMetadata()` returns the resource metadata an HTTP adapter can publish at the
well-known OAuth protected-resource endpoint. OAuth token issuance remains pluggable.
