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

## Configuration

`WpMcpServerConfig` is built with fluent setters — every name sits next to its own value, so no two
settings can be swapped, and a future setting is an additive setter rather than a breaking signature
change. Expect to supply the type arguments explicitly:

```ts
const config = new WpMcpServerConfig<MyGrant, MyMintRequest>()
    .setName('my-server')
    .setVersion('1.0.0')
    .setResource('https://api.example.com/mcp')
    .setAccessTokenAuthority(authority)
    .setEndpointJwtAuthority(jwtHook)
    .setEndpointMintRequest((credential) => new MyMintRequest(credential.subject))
    .setAuthorizationServers(['https://login.example.com'])
    .setRequiredScopes(['tools'])
    .setErrorTranslator(new MyMcpErrorTranslators())
    .setMaxAccountValidationAgeSeconds(15 * 60);
```

Each setter validates its own value immediately and names itself in the failure: `setResource(...)`
and every entry of `setAuthorizationServers(...)` must be an absolute URL, because they are compared
against a token's audience and issuer. `setMaxAccountValidationAgeSeconds` and
`setMaxEndpointJwtLifetimeSeconds` default to one hour and are capped there.
`setErrorTranslator(...)` is the only optional non-ceiling setting; everything else is required and
`WpMcpServer.bind(...)` fails at startup listing **every** missing setter
(`WpMcpServerConfig is missing setResource(...)`). That is deliberate: a misconfigured audience or
issuer otherwise surfaces as a first-request `401 + WWW-Authenticate`, which is the OAuth discovery
signal, so a client answers it by re-authenticating and failing again — forever.

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

`bind(...)` registers POST at that path plus a 405 (`Allow: POST`) for every other method there — MCP
2026-07-28 has no session GET, so a probe gets a method error rather than a 404. It may be called only
once: one server serves exactly one canonical resource URI. `WpMcpServerConfig.resource` is that URI,
fixed for the process lifetime and never derived from the request `Host` (a host-derived audience would
make the boundary's own audience check circular — a confused deputy), and its path must equal
`endpointPath`, which `bind(...)` verifies. A second hostname is a second deployment, not a second
audience.

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

### The application's own `tools/call` translation

An app owns its error taxonomy and owns how those errors should be explained to a model, so it gets
FIRST REFUSAL on every `tools/call` failure — the same convention `ExpressWrapper.handleError`
applies on the HTTP path through `ClientRegistry.tryTranslateToWire`. Register one with
`WpMcpServerConfig.setErrorTranslator(...)`; it is a setter and not a global, because `WpMcpServer` is
constructed by app code and two servers may run in one process.

```ts
class LangMcpErrorTranslators implements McpErrorTranslators {
    toToolResult(error: Error, scope: McpFailureScope): CallToolResult | undefined {
        if (!(error instanceof LangPassageLockedError)) return undefined; // not mine
        return {
            content: [{ type: 'text', text: `Passage ${error.passageId} is locked.` }],
            structuredContent: { passageId: error.passageId, action: 'ask_the_user_to_unlock' },
            isError: true,
        };
    }
}
```

- `error` is the RAW thrown value, NOT normalized, so `instanceof` on the app's own classes works.
- Returning `undefined` means "not mine" and the webpieces default renders, unchanged.
- A claimed error owns the ENTIRE `CallToolResult` — content, `structuredContent`, `isError`.
- webpieces default-fills `_meta["webpieces/requestId"]` only when the returned result has no
  `_meta`; an app that sets `_meta` keeps it untouched.
- Operator-detail logging has already run when the translator is called, so claiming an error can
  never silently kill observability. A translator that THROWS is itself reported through the same
  boundary and the original error still renders the reply.
- The scope is `tools/call` ONLY. `tools/list` and the pre-SDK HTTP boundary stay framework-owned:
  that boundary emits the `401 + WWW-Authenticate: Bearer resource_metadata=...` MCP clients depend
  on for OAuth discovery, and an app rewriting it breaks connector onboarding in a way that is
  extremely hard to debug.

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

That endpoint's URL is `WpMcpServerConfig.resourceMetadataUrl` — RFC 9728 §3.1 path insertion, so
`https://host/mcp` publishes at `https://host/.well-known/oauth-protected-resource/mcp` — and it is the
value of `resource_metadata` in the 401 `WWW-Authenticate` challenge. RFC 9728 §5.1 defines that
parameter as the URL of the metadata DOCUMENT, never the resource identifier itself. The framework
mounts no `.well-known` route; the app publishes the document there.
