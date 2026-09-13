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
and an `McpAccessTokenVerifier`. The verifier checks issuer, signature, expiry, scopes, and the exact
resource URI, then returns an endpoint bearer credential. The bridge uses that credential only for an
in-process call through the ordinary `AuthFilter`; it never forwards the MCP token to downstream APIs.

`protectedResourceMetadata()` returns the resource metadata an HTTP adapter can publish at the
well-known OAuth protected-resource endpoint. OAuth token issuance remains pluggable.
