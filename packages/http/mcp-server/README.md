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
`ApiJsonSchema.isClosedSchema(schema)`, not `schema.additionalProperties === false`, which wrongly
rejects typed maps.

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
