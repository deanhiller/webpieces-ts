# @webpieces/mcp-server

Publishes explicitly annotated Webpieces RPC endpoints as MCP tools. The bridge is HANDED the input
and output JSON Schema — the build extracts them from the contract source and writes `mcp-tools.json`
— invokes the normal Webpieces filter/controller path, and turns exceptions into safe model-visible
MCP results.

`@WpMcpTool` is an opt-in and every tool must also declare `@WpMcpAuthJwt`. MCP user
authorization and endpoint transport authentication are deliberately separate. The MCP adapter
never accepts trusted context values from tool arguments or unverified headers.

```ts
interface FindOrderRequest {
    /** Order identifier */
    orderId: string;
}

interface FindOrderResponse {
    /** Current order state */
    state: string;
}

@ApiPath('/orders')
@ApiType(SVC_TO_SVC, MCP)
abstract class OrdersApi {
    /** Find one order owned by the signed-in user. */
    @WpMcpAuthJwt({ allRolesAllowed: true })
    @WpAuthJwt({ allRolesAllowed: true })
    @Endpoint(POST, '/find', READ, RPC)
    @WpMcpTool('orders_find')
    find(request: FindOrderRequest): Promise<FindOrderResponse> {
        throw new Error('contract only');
    }
}
```

## Everything but the tool NAME comes from the source

`@WpMcpTool` takes one argument, the stable protocol name, because that is the only fact the source
cannot state. Everything else is read off the contract by `@webpieces/api-doc-model` at BUILD time:

| fact | source |
|---|---|
| `description` | the method's JSDoc body, or its `@mcp` tag — the same words the partner reads in OpenAPI |
| `inputSchema` / `outputSchema` | the declared request and response types, with each field's JSDoc as its description |
| `readOnlyHint` / `destructiveHint` / `idempotentHint` | `@Endpoint`'s `operation` — `READ`, `WRITE_IDEMPOTENT` or `WRITE` |
| `openWorldHint` | `@Endpoint`'s `openWorld` option |
| `x-mcp-header` | the field's `@mcpHeader <token>` JSDoc tag |

Every `@Endpoint` declares one enum-backed operation, independent of its required `GET` or `POST`
argument: a GET may deliberately write and a POST may be a read. A tool therefore cannot claim to be
read-only while its endpoint declares `WRITE` — the contradiction is unrepresentable.

## Booting: the server is constructed with the generated catalog

```bash
wp-openapi --manifest openapi.manifest.json --out dist
```

writes `mcp-tools.json` beside the OpenAPI documents. Hand it to `McpBindOptions`:

```ts
const catalog = McpToolCatalog.fromJsonText(fs.readFileSync('dist/mcp-tools.json', 'utf8'));
server.bind(app, new McpBindOptions(path, bindings, catalog, McpDeployment.singleProcess()));
```

`McpToolRegistry` FAILS FAST at boot when a registered `@WpMcpTool` is absent from the catalog: a tool
the build never saw is a tool whose schema nobody checked. Tool arguments and structured output are
validated against those same schemas by `ApiJsonSchemaValidator`, so the shape an agent is shown and
the shape the server accepts are the same bytes rather than two derivations of one contract.

Before #984 the schemas were instead built at boot from `@WpDtoField` reflect-metadata. That spelling,
`@WpDto`, `WpDtoFieldOptions`, `WpDtoMapFieldOptions`, `WpMcpHeader`, `@WpResponseDto` and
`DtoSchemaBuilder` are all DELETED — see the migration note in `responsibilities.md`.

### Typed maps

A `Record<string, V>` is read straight off the declared type and emits
`{ type: 'object', additionalProperties: <value schema> }`. Validation checks every value
(`$.translations.es must be a string`). A map is still a CLOSED schema: no key can carry an unspecified
value, and `ApiJsonSchema.isClosed(schema)` answers that for both forms — use it rather than
`schema.additionalProperties === false`, which wrongly rejects typed maps.

### Nullable

`externalId: string | null` publishes as `type: ["string", "null"]`, which is a different wire document
from omitting the key. OPTIONAL (`externalId?: string`) is the absence of the field from `required`.
The two are kept apart.

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
    .setMaxAccountValidationAgeSeconds(15 * 60);

// The tools/call error translator is a PROCESS-GLOBAL, not a member of this config:
McpRegistry.setErrorTranslator(new MyMcpErrorTranslator());
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

`bind(...)` registers POST at that path plus a 405 (`Allow: POST`) for every other method there —
neither served era has a session GET here (2026-07-28 has none at all, and the 2025 leg is the SDK's
STATELESS fallback, which answers the 2025 session GET/DELETE with the same 405), so a probe gets a
method error rather than a 404. It may be called only
once: one server serves exactly one canonical resource URI. `WpMcpServerConfig.resource` is that URI,
fixed for the process lifetime and never derived from the request `Host` (a host-derived audience would
make the boundary's own audience check circular — a confused deputy), and its path must equal
`endpointPath`, which `bind(...)` verifies. A second hostname is a second deployment, not a second
audience.

## Protocol revisions: negotiated, never pinned

One endpoint serves BOTH MCP wire eras from one tool registry — modern (2026-07-28, per-request
`_meta` envelope) and legacy (the 2025-11-25 family, negotiated by `initialize`). The official SDK
classifies each request and answers it on the matching leg, calling the SAME server factory for both,
so the two eras can never drift apart. There is no configuration for this and no way to turn it off:
a revision an app can pin is a revision an app can pin itself out of reach with, which is exactly what
happened when this bridge was modern-only and every shipping client (all still on the 2025
generation) got `-32022 Unsupported protocol version` at `initialize`. Only a revision NO era knows is
refused, which is what the MCP lifecycle spec asks of a server.

The external bearer is verified identically on both legs, at the `bind(...)` HTTP boundary, before the
SDK is involved — the era is the SDK's decision, the authentication is not.

The official MCP v2 server and Node adapter own JSON-RPC validation for both eras, JSON versus
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
current account state. Neither served era keeps a session here, so the bearer is verified once per POST
at the `bind(...)` HTTP boundary, before the SDK is involved; tool handlers never re-verify it. A
rejected token must be thrown as `ApiUnauthorizedError` (answered 401 + `WWW-Authenticate`); any
other throw from the authority is an implementation failure (500). Endpoint JWTs are capped at one
hour and MCP access tokens at 30 days.

## Error boundary

`WpMcpErrorTranslator` is the one place a failure becomes an MCP reply, mirroring
`WebpiecesDefaultErrorTranslator`: an error in, the exact wire shape out. Each entry point has exactly one catch
that only delegates to it; the dispatcher and the local/remote invokers have none. Classification is
the shared `ApiErrorBoundary.encode` rule (a non-`ApiError`, or a caller-local `ApiConnectionError`,
publishes as kind `implementation`). The boundary never substitutes an object for the thrown error,
so an app's `McpErrorTranslator` can `instanceof` its own error classes.

There is ONE method per BOUNDARY, named for the boundary it guards. They cannot be one shape — the
MCP spec fixes each — so the three-ness is made obvious rather than accidental:

| Boundary | Method | Reply |
|---|---|---|
| before the SDK: bearer, `Origin`, malformed body | `toBearerBoundaryResponse(error): HttpResponseDto<McpHttpErrorBody>` | HTTP 401 + `WWW-Authenticate` / 403 / 400, anything else 500 |
| `tools/list` | `toListError(error): never` | throws JSON-RPC `-32602` (bad request) or `-32603` `Internal Error` |
| `tools/call`, tool found: bad arguments, `@WpMcpAuthJwt` denial, JWT/OIDC mint failure, any local or remote failure, output-schema or serialization failure | `toToolCallResult(error): CallToolResult` (delegates to `McpRegistry.getErrorTranslator().toWire`) | `isError: true` result |
| `tools/call`, unknown tool name | `unknownTool(name)` | JSON-RPC `-32602` `Unknown tool: <name>` |

The pre-SDK boundary produces a VALUE like every other API in the framework and `WpMcpServer` writes
it through the same `ExpressResponseWriter` the ordinary HTTP path uses — it does not hand-roll
`res.status(...).json(...)`. The body stays JSON-RPC shaped because an MCP client expects that;
`HttpResponseDto` is generic and its header LIST carries `WWW-Authenticate`.

`toListError` is typed `never` — it THROWS rather than returning a value the caller must remember to
throw — and it is LOAD-BEARING for disclosure, not defence in depth: the official SDK wraps a foreign
throw in `-32603` but copies its `message` onto the wire verbatim (measured and pinned by
`McpSdkForeignThrow.spec.ts`).

**Operator logging is NOT in the translator.** The edges with no filter chain above them — bearer
verification, `Origin`, a malformed body, `tools/list` — are wrapped in `LogApiCall`, which is this
repo's one line on logging; `tools/call` dispatches through the ordinary filter chain, so
`LogApiFilter` owns its line. Exactly one `[API-server-resp-FAIL]` / `-OTHER` line per failure, with
the request, the identity and the timing on it, and none of the barer second line
`ApiErrorBoundary.logOperatorDetail` used to add.

`subscriptions/listen` is served entirely by the SDK's listen router, so Webpieces has no handler there.

`requestId` comes from `RequestContext` and the JSON-RPC id and tool name from the request scope,
so none of the three methods takes a correlation parameter — the deleted `McpFailureScope` was a copy
of context the renderers can already read.

The default `content[0].text` is JSON with an explicit `{ "error": { ... } }` envelope, because some
clients display only content and hide the top-level MCP `isError`. The nested error carries the
precise `kind`, a small ownership `category`, explicit `retry` guidance, a safe message, and the
`requestId`. It may also carry safe fields such as `field`, `callerMessage`, `errorCode`,
`retryAfterSeconds`, and `statusCode`. It never repeats `isError` inside the content.

Implementation failures are `category: "bug", retry: "never"` and tell the caller to give the
request ID to support; operator details remain redacted. Generic dependency failures are also
non-retryable. Specific gateway, timeout, unavailable, throttling, and backoff failures are
temporary, but a retry is described as safe only for a `read` or `write-idempotent` endpoint. A
`write` reports `retry: "unsafe-outcome-unknown"`, because a lost response does not prove the write
failed to commit.

Every reply carries the requestId so a user can quote it: `_meta["webpieces/requestId"]` on every
`tools/call` result (success or `isError`), `requestId` in the `isError` payload, and
`error.data.requestId` on JSON-RPC and HTTP-boundary errors.

### The application's own `tools/call` translation

An app owns its error taxonomy and owns how those errors should be explained to a model, so a
registered translator REPLACES the webpieces default for every `tools/call` failure — the same
convention `ExpressWrapper.handleError` applies on the HTTP path. Register one with
`McpRegistry.setErrorTranslator(...)`: ONE process-global per protocol, mirroring `ClientRegistry`
for HTTP and `IpcRegistry` for IPC, so every call site is one unconditional line. (Two MCP servers in
one process therefore share one translator, and registration order matters rather than being fixed at
construction — the trade taken deliberately in issue #968 to make all three protocols read alike.)

```ts
class LangMcpErrorTranslator implements McpErrorTranslator {
    private readonly fallback = new McpDefaultToolCallRenderer();

    toWire(error: Error): CallToolResult {
        if (!(error instanceof LangPassageLockedError)) {
            return this.fallback.toWire(error); // not mine -> webpieces default
        }
        return {
            content: [{ type: 'text', text: `Passage ${error.passageId} is locked.` }],
            structuredContent: { passageId: error.passageId, action: 'ask_the_user_to_unlock' },
            isError: true,
        };
    }
}
```

- `error` is the thrown value itself — webpieces never substitutes another object for it, so
  `instanceof` on the app's own classes works.
- There is no "not mine" return. Decline by DELEGATING to `McpDefaultToolCallRenderer`, the public
  class that IS the webpieces default, so declining is byte-identical to registering nothing.
- A claimed error owns the ENTIRE `CallToolResult` — content, `structuredContent`, `isError`.
- webpieces default-fills `_meta["webpieces/requestId"]` only when the returned result has no
  `_meta`; an app that sets `_meta` keeps it untouched.
- The failure has already been logged by the filter chain when the translator is called, so claiming
  an error can never silently kill observability. A translator that THROWS is reported on its own
  line and the original error still renders the reply.
- The scope is `tools/call` ONLY. `tools/list` and the pre-SDK HTTP boundary stay framework-owned:
  that boundary emits the `401 + WWW-Authenticate: Bearer resource_metadata=...` MCP clients depend
  on for OAuth discovery, and an app rewriting it breaks connector onboarding in a way that is
  extremely hard to debug.

A remote binding's generated client preserves typed dependency gateway, unavailable, timeout, and
backoff failures. Foreign/bodyless responses are classified by status: 408/504 timeout, 429 backoff,
502 bad gateway, and 503 unavailable (or backoff when `Retry-After` is present). Other 4xx remains
the caller service's `ApiImplementationError`; other 5xx remains generic `ApiDependencyError`.

### Why there is no `fromWire` on `McpErrorTranslator`

The HTTP and IPC translators have two halves because webpieces sits on both ends of those wires.
**webpieces is never the MCP client** — Claude is — so there is no return path for webpieces to
translate. The pair is one-directional by nature, not by omission.

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
