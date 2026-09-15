# @webpieces/mcp-server

Publishes explicitly annotated Webpieces RPC endpoints as MCP tools. The bridge generates input and
output JSON Schema from DTO metadata, invokes the normal Webpieces filter/controller path, and turns
exceptions into safe model-visible MCP results.

`@WpMcpTool` is an opt-in and every tool must also declare `@WpMcpAuthJwt`. MCP user
authorization and endpoint transport authentication are deliberately separate. The MCP adapter
never accepts trusted context values from tool arguments or unverified headers.

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
    @WpMcpAuthJwt({ allRolesAllowed: true })
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

Applications supply the endpoint path, explicit bindings, and deployment topology. There is no
framework-owned `/mcp` path:

```ts
const mcp = new WpMcpServer(config);
mcp.bind(expressApp, new McpBindOptions(
    connectorConfig.endpointPath,
    [
        McpApiBinding.local(OrdersApi, apiFactory),
        McpApiBinding.remote(RemoteOrdersApi, () => remoteOrdersClient),
    ],
    McpDeployment.singleProcess(),
));
```

The official MCP v2 server and Node adapter own MCP 2026-07-28 JSON-RPC validation, JSON versus
request-scoped SSE responses, backpressure, cancellation, keepalives, and subscriptions. Webpieces
owns the Express path, root `RequestContext`, authentication boundary, schema-derived tool registry,
and dispatch through the normal API proxy.

During a tool invocation, `RequestContext.getTrusted(MCP_INVOCATION_CONTEXT)` exposes the verified
JSON-RPC ID, tool/user/role facts, the official SDK cancellation `AbortSignal`, and (when the client
supplied `_meta.progressToken`) a `reportProgress(...)` callback. Progress remains related to that
one request and causes the official handler to select request-scoped SSE; closing that response
aborts the same signal. The context key has no HTTP header and is never propagated as caller input.

For a local binding the API method must combine `@WpMcpAuthJwt` with `@WpAuthJwt`. Before every tool
call the bridge asks the application `JwtHook` to mint a distinct short-lived endpoint JWT and invokes
`ApiFactory.createApiClient`, preserving `JwtHook`, `LogApiFilter`, and `AuthFilter`. Literal MCP-token
passthrough is rejected. For a remote binding the endpoint must use `@WpAuthOidc`; the generated Node
client supplies its service credential and propagates only trusted delegated context established by
the MCP access-token authority. Neither an external MCP bearer nor a browser session JWT is sent to
the downstream endpoint.

`McpDeployment.singleProcess()` uses an in-memory invalidation bus and makes that limit explicit.
Distributed deployments must use `McpDeployment.distributed(sharedBus)`. List responses have a bounded
TTL, registry metadata contains a surface-derived revision, `toolsChanged()` publishes a
level-triggered invalidation, and `close()` drains active response streams. A reconnecting client must
re-listen and refresh its authoritative lists; notifications are not a durable or replayable event log.

The authority verifies issuer, signature/token state, expiry, scopes, the exact resource URI, and
current account state on every MCP operation. Endpoint JWTs are capped at one hour and MCP access
tokens at 30 days.

The verifier's `accountValidatedAtEpochSeconds` must represent an authoritative enabled/revoked and
role/scope read. The bridge enforces a maximum one-hour decision age; per-request reads are preferred so
offboarding and role changes take effect on the next call. JWT access-token implementations must enforce
an explicit algorithm allowlist plus issuer, exact audience/resource, expiry, type/version, and key
rotation metadata. Opaque tokens remain valid implementations of the same authority contract.

`protectedResourceMetadata()` returns the resource metadata an HTTP adapter can publish at the
well-known OAuth protected-resource endpoint. OAuth token issuance remains pluggable.
