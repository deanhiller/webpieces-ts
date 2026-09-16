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

### Typed maps

A `Record<string, V>` reflects as plain `Object`, so its value type must be declared — the same reason
`arrayItems` exists for arrays. Use `WpDtoMapFieldOptions(description, required, mapValues)`, where
`mapValues` is `'string' | 'number' | 'integer' | 'boolean'` or a `@WpDto` class:

```ts
@WpDto()
class PassageSentenceItem {
    @WpDtoField(new WpDtoFieldOptions('Sentence text', true))
    text!: string;

    @WpDtoField(new WpDtoMapFieldOptions('ISO 639-1 -> sentence', false, 'string'))
    translations?: Record<string, string>;
}

@WpDto()
class PassageResponse {
    @WpDtoField(new WpDtoMapFieldOptions('Sentences by locale', true, PassageSentenceItem))
    sentencesByLocale!: Record<string, PassageSentenceItem>;
}
```

The field emits `{ type: 'object', additionalProperties: <value schema> }`, and validation checks every
value (`$.translations.es must be string`). An `Object`-typed field without map options — an interface or
an undeclared `Record` — fails at startup, because an interface can never carry `@WpDto`.

A map is still a closed schema: no key can carry an unspecified value. Check closure with
`new DtoSchemaBuilder().isClosedSchema(schema)`, not `schema.additionalProperties === false`, which wrongly
rejects typed maps.

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
current account state. MCP 2026-07-28 has no sessions, so the bearer is verified exactly once per POST
at the `bind(...)` HTTP boundary, before the SDK is involved; tool handlers never re-verify it. A
rejected token must be thrown as `ApiUnauthorizedError` (answered 401 + `WWW-Authenticate`); any
other throw from the authority is an implementation failure (500). Endpoint JWTs are capped at one
hour and MCP access tokens at 30 days.

## Error boundary

`WpMcpErrorTranslator` is the one place a failure becomes an MCP reply, mirroring
`ApiErrorHttpMapper`. Each entry point has exactly one catch that only delegates to it; the dispatcher
and the local/remote invokers have none. Normalization is the shared `ApiErrorBoundary` rule (a
non-`ApiError`, or an `ApiConnectionError`, becomes `ApiImplementationError`), and each failure is
logged once at the same per-kind level as HTTP, with `requestId`, JSON-RPC id and tool name.

| Where | Reply |
|---|---|
| `tools/call`, tool found: bad arguments, `@WpMcpAuthJwt` denial, JWT/OIDC mint failure, any local or remote failure, output-schema or serialization failure | `isError: true` result |
| `tools/call`, unknown tool name | JSON-RPC `-32602` `Unknown tool: <name>` |
| `tools/list` | JSON-RPC `-32602` (bad request) or `-32603` `Internal Error` |
| before the SDK: bearer, `Origin`, malformed body | HTTP 401 + `WWW-Authenticate` / 403 / 400, anything else 500 |

`subscriptions/listen` is served entirely by the SDK's listen router, so Webpieces has no handler there.

What the model reads inside an `isError` result: an `ApiEndUserError` message verbatim plus
`errorCode` (it survives the remote hop byte-for-byte); an `ApiBadRequestError`'s `callerMessage` and
`field`, never its operator `message`; for an implementation failure, generic text naming the tool and
requestId and saying it is a bug in the tool, not in the arguments; for every other kind, that kind's
generic message plus `retryAfterSeconds` where present, and for an `ApiCodedError` its
`statusCode` and `errorCode`.

Every reply carries the requestId so a user can quote it: `_meta["webpieces/requestId"]` on every
`tools/call` result (success or `isError`), `requestId` in the `isError` payload, and
`error.data.requestId` on JSON-RPC and HTTP-boundary errors.

A remote binding's generated Node client turns a dependency's 4xx into the gateway's own
`ApiImplementationError` (see `NodeProxyClient.adaptDownstreamFailure`). A gateway that wants the model
to see the peer's typed 4xx instead registers an `ErrorTranslators` via
`ClientRegistry.setErrorTranslators(...)` whose `fromWire` relays decoded Webpieces payloads; with it,
local and remote bindings produce identical tool results.

The verifier's `accountValidatedAtEpochSeconds` must represent an authoritative enabled/revoked and
role/scope read. The bridge enforces a maximum one-hour decision age; per-request reads are preferred so
offboarding and role changes take effect on the next call. JWT access-token implementations must enforce
an explicit algorithm allowlist plus issuer, exact audience/resource, expiry, type/version, and key
rotation metadata. Opaque tokens remain valid implementations of the same authority contract.

`protectedResourceMetadata()` returns the resource metadata an HTTP adapter can publish at the
well-known OAuth protected-resource endpoint. OAuth token issuance remains pluggable.
