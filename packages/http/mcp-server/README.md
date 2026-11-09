# @webpieces/mcp-server

Publishes explicitly annotated Webpieces RPC endpoints as MCP tools. The bridge is HANDED the input
and output JSON Schema — the build extracts them from the contract source and writes one
`mcp-<ContractClass>-tools.json` per contract — invokes the normal Webpieces filter/controller path, and turns exceptions into safe model-visible
MCP results.

`@WpMcpTool` opts an endpoint into the protocol. Every endpoint declares canonical
`@WpAuth` credentials and common `@WpAuthorization` policy. The same policy governs tool visibility,
schema lookup, dispatch and receiving endpoint execution. The MCP adapter never accepts trusted
context from tool arguments or unverified headers.

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
    /**
     * Find one order owned by the signed-in user.
     *
     * @summary Find orders
     * @returns The order, with its current state.
     */
    @WpAuth([jwt()])
    @WpAuthorization({ authType: AuthorizationType.ALL_USERS })
    @Endpoint(POST, '/find', READ, RPC)
    @WpMcpTool('orders_find')
    find(request: FindOrderRequest): Promise<FindOrderResponse> {
        throw new Error('contract only');
    }
}
```

## Everything but the tool NAME comes from the source

`@WpMcpTool(name)` takes ONE argument (plus the optional profiles object), because the stable protocol
name is the only fact the source cannot state. It must be 1-64 characters of `[A-Za-z0-9_-]` — the
Claude Connectors Directory refuses a server with a longer name — and `McpToolName` enforces that rule
at decoration time, in `wp-openapi` (every offender named in one run), in `api-rules-for-mcp`, and when a
catalog is loaded.

The TITLE is the method's `@summary` JSDoc tag (#1296): one line, at most 100 characters, REQUIRED on
every published operation. It is the same line the OpenAPI documents publish as the operation's
`summary`, so a partner's docs page and an agent's tool list name the endpoint identically, and
`tools/list` publishes it as BOTH the top-level `Tool.title` and `annotations.title` (#1180). The title
argument the decorator used to take is gone — passing one is a compile error — and a catalog entry
with no title is refused when it is loaded, so a stale catalog fails the boot instead of publishing
untitled tools. Write the title a person would read ("Find orders"); never derive it from the name.
Everything else is read off the contract by `@webpieces/api-doc-model` at BUILD time:

| fact | source |
|---|---|
| `title` / `annotations.title` | the method's `@summary` JSDoc tag — the OpenAPI operation's `summary` |
| `description` | the method's JSDoc body, or its `@mcp` tag — the same words the partner reads in OpenAPI |
| `inputSchema` / `outputSchema` | the declared request and response types, with each field's JSDoc as its description; `inputSchema.description` is the request DTO's JSDoc and `outputSchema.description` is the method's `@returns` — the sentence OpenAPI publishes as the success response's description (#1292) |
| `readOnlyHint` / `destructiveHint` / `idempotentHint` | `@Endpoint`'s `operation` — `READ`, `WRITE_IDEMPOTENT` or `WRITE` |
| `openWorldHint` | `@Endpoint`'s `openWorld` option |
| `x-mcp-header` | the field's `@mcpHeader <token>` JSDoc tag |

No `@privateRemarks` text reaches any of it: the generator drops the tag at extraction, and it refuses
a tool whose method has no `@returns` or that reaches a schema with no JSDoc description, exactly as it
refuses them for OpenAPI (#1292). The server serves the catalog's descriptions verbatim —
`McpServedDescriptions.integration.spec.ts` boots it on the partner-api golden catalog and reads them
back through `tools/list`.

Every `@Endpoint` declares one enum-backed operation, independent of its required HTTP verb
argument: a GET may deliberately write and a POST may be a read.

A method that binds any argument to the URL (`@PathParam` / `@QueryParam`) is not an MCP tool: a
tool receives exactly one input object, so `McpToolRegistry` refuses `@WpMcpTool` on such a method
at boot. A tool therefore cannot claim to be
read-only while its endpoint declares `WRITE` — the contradiction is unrepresentable.

## One toolset, two transports

The TOOLS and their POLICY are the same for every caller; only the way in differs. So the package is
split in two layers:

- **`McpToolset`** — the shared core: WHICH tools are served (bindings, catalogs, profiles), the
  per-caller `AuthorizedMcpTools` projection, input/output schema validation, dispatch through
  `binding.invoke`, and error translation. Its ONLY input about the caller is the CURRENT
  `RequestContext` — the trusted USER_ID / USER_ROLES / ORG_ID and a `VerifiedMachineCaller`, exactly what
  `AuthorizationService.authorize` reads. `@WpAuthorization` on the contract is the single policy everywhere.
- **a transport** — whose only job is to establish that context.

```ts
const toolset = new McpToolset(
    [McpApiBinding.local(StoresApi, router)],               // McpApiBinding.local / .remote, unchanged
    McpToolCatalog.fromPackages(['@myorg/my-apis'], __dirname),
    router.authorizationService(),
    ['user'],                                               // #1187 profiles: WHICH tools this toolset serves
);
```

| transport | the caller is | use |
|---|---|---|
| `WpMcpInMemory.connect(toolset)` | whoever is trusted in the `RequestContext` of the code calling the client | an in-process agent that runs its own model loop (ai-chat) |
| `new WpMcpServer(config, toolset).bind(app, options)` | whoever ONE of `config.setAuth([...])`'s modes verified | a service-to-service hop, a customer's AI, an off-the-shelf connector |

### In-memory

```ts
const client: Client = await WpMcpInMemory.connect(toolset);   // MCP SDK Client, InMemoryTransport pair
// inside a request whose caller the endpoint's AuthFilter already verified:
const { tools } = await client.listTools();
await client.callTool({ name: 'stores_pause', arguments: { storeId } });
```

There is no credential. The caller is READ PER REQUEST from the `RequestContext` of the code calling
`listTools()` / `callTool()`, and NEVER captured at connect: apps cache one client per process, so a
connect-time capture would run user B's call as user A. The SDK delivers each in-memory message
synchronously inside the caller's own `send` (as a JSON copy, exactly what the wire would carry), so the
toolset's handlers run in the caller's async context. A call made outside any `RequestContext` is refused,
never run as nobody. The tool runs in the caller's own scope, so a local binding's
`InvocationAuthentication` finds the verified ingress the endpoint's `AuthFilter` completed there. No
tools/list cache hint is sent, so the shared client never serves one caller's list to another.

### HTTP

One server = one path = one toolset (one profile set). `/mcp/user` and `/mcp/admin` are two servers over
two toolsets — paths split by WHICH TOOLS, never by HOW THE CALLER AUTHENTICATES.

### Several clients: `McpClientSet`

An agent may hold several clients — its in-memory toolset plus another service's remote endpoint. Tool
names are flat across servers, so `McpClientSet.merge([...])` refuses a name two clients publish
(`McpDuplicateToolError`, at connect time and again on every `listTools()`, because each server projects
per caller) and routes `callTool` by name.

## HTTP authentication: an OR-set of the existing `@WpAuth` modes, plus `mcpOAuth(...)`

There is no second auth vocabulary. The server takes the same builders endpoints use, verified by the
same hooks the endpoint `AuthFilter` uses (`router.credentialVerifiers()`):

```ts
new WpMcpServerConfig()
    .setName(...).setTitle(...).setDescription(...).setWebsiteUrl(...).setVersion(...)
    .setResource('https://api.example.com/mcp/user')
    .setAuth([oidcSameProject()])                                         // now: internal only
    .setCredentialVerifiers(router.credentialVerifiers());
//  .setAuth([oidcSameProject(), jwt(), apiKey('partner', creds),         // later: customers' AI
//            mcpOAuth(authority, ['https://login.example.com'], ['tools'],
//                     McpAccessTokenFormat.opaquePrefix('wpmcp_'))])
```

| mode | claims a request carrying | use |
|---|---|---|
| `oidcSameProject()` / `oidcSvcs([...])` | `Bearer` with a Google `iss` (or an off-GCP `dev-oidc.` token) | internal svc-to-svc MCP; the only modes (with `sharedSecret`) whose forwarded trusted context is believed |
| `jwt()` | every other `Bearer` no other configured mode claims | the app's `JwtHook` — our own user token, or a customer agent holding it |
| `apiKey(regime, creds)` | its own declared header(s) | a customer's custom agent |
| `sharedSecret(key)` | `Authorization: Webpieces <secret>` | internal deployments that chose it |
| `mcpOAuth(...)` **(new)** | `Bearer` of the shape its `McpAccessTokenFormat` declares | off-the-shelf connectors (Claude / ChatGPT): RFC 9728 metadata, 401 `WWW-Authenticate` discovery, audience = canonical resource |
| `vendorAuth(...)` / public | — | refused at startup: no caller identity to authorize tools against |

`mcpOAuth(authority, authorizationServers, requiredScopes, tokenFormat, maxAccountValidationAgeSeconds?)`
holds everything OAuth-only — the former `setAccessTokenAuthority`, `setAuthorizationServers`,
`setRequiredScopes` and `setMaxAccountValidationAgeSeconds` setters, which are DELETED. They are
required only when the mode is in the set. `tokenFormat` says how the authority's tokens look:
`McpAccessTokenFormat.opaquePrefix('wpmcp_')`, `.jwtIssuer()` (a JWT whose `iss` is one of
`authorizationServers`), or `.everyBearer()` (legal only when no other bearer mode is in the set).
`WpMcpServer.protectedResourceMetadata()` exists only on a server with `mcpOAuth(...)`.

### Classify, then verify with exactly ONE verifier

Credentials are self-describing, so one path serves every mode. The request is classified from
UNVERIFIED surface facts — which header; a JWT's unverified `iss` — and handed to exactly ONE verifier.
Classifying on unverified data is safe because the chosen verifier fully verifies: a token that merely
claims `iss: accounts.google.com` fails Google's verification and the request is a 401. It never falls
through to another mode.

- No claimant: an `mcpOAuth(...)` server answers with the discovery challenge; any other server a plain 401.
- Two claimants (an api-key header AND a bearer): ambiguous, refused — never "pick the one that works".
- One claimant: its rejection IS the answer. An authenticated caller lacking a role gets the normal
  authorization refusal (a hidden tool), never a retry as another mode.
- Only `mcpOAuth(...)` emits `WWW-Authenticate` discovery; every other rejection is a plain 401 with no
  hint of which mode came closest.
- `claims()` sets are disjoint BY CONSTRUCTION, and `bind(...)` refuses a set that could overlap
  (`mcpOAuth(..., everyBearer())` or a bearer `apiKey(...)` beside another bearer mode, an
  `mcpOAuth(..., jwtIssuer())` trusting a Google issuer beside an OIDC mode), a mode whose verifier is
  not bound (naming the binding line), and `vendorAuth` / public.
- Trusted context and surface (`llm`) come from the mode that authenticated. Inbound trusted headers are
  reconciled exactly as on ordinary routes: believed only from a verified OIDC / shared-secret hop, and on
  every other mode admitted only when the credential itself vouched for the same value.

### `WpMcpRemote`: the client for the internal door

```ts
const client = await WpMcpRemote.connect('https://svc-b.example.com/mcp/user', oidcSameProject(), gcpOidc);
```

An MCP SDK `Client` whose transport, PER POST, mints an OIDC ID token for the callee origin (as
`http-client-node` does — `gcpOidc` is `GcpOidc` from `@webpieces/gcp-identity`) and forwards the current
`RequestContext`'s transferable keys, trusted ones included, so the callee's `@WpAuthorization` judges the
user on whose behalf THIS call is made. Per POST for the same cached-client reason as in-memory; it
caches no response either.

## Endpoints need NO new auth for MCP

The MCP credential never becomes a downstream credential: a local binding passes a token-free
`InvocationAuthentication` through the ordinary filter chain, and a remote binding uses the contract's
own `oidcSameProject()` / `oidcSvcs(...)` / `sharedSecret(...)`. So ONE method serves an in-process agent
(in-memory) and a customer's LLM (HTTP `jwt()` / OAuth) unchanged — add `jwt()` to `@WpAuth` only if a
GUI also calls the endpoint directly:

```ts
@WpAuth([oidcSameProject()])
@WpAuthorization({ authType: AuthorizationType.ROLES, roles: ['OPERATOR', 'MEALCO_OPS'] })
@Endpoint(POST, '/pause-store', WRITE, RPC)
@WpMcpTool('stores_pause', { profiles: ['user'] })
```

### `SERVICE_ONLY` can never be an MCP tool

`AuthorizationType.SERVICE_ONLY` admits a bare service hop — current-hop machine evidence and nothing
about a user. An MCP call is always made on behalf of a MODEL, so such a policy is wrong in both
directions: behind an HTTP door with a user-token mode every model call is denied, and behind an OIDC door
or an in-memory client running in an OIDC-ingressed request the service hop itself would satisfy it —
admitting every model behind that service. So `McpToolset` REFUSES to build when a `@WpMcpTool` declares
`SERVICE_ONLY`, naming the method. Use `USERS_OR_SERVICES`, `ALL_USERS` or `ROLES` on anything you mark
`@WpMcpTool`.

## Booting: the toolset is constructed with the generated catalogs

The api library's build (its `openapi-generate` target — tag the library `generate:openapi`) writes one
`mcp-<ContractClass>-tools.json` per MCP contract into its build output, beside the OpenAPI documents.
Hand them to `McpToolset` with ONE call that works in every environment:

```ts
const catalogs = McpToolCatalog.fromPackages(['@myorg/my-apis'], __dirname);
const toolset = new McpToolset(bindings, catalogs, router.authorizationService(), [Mcp.DEFAULT]);
```

`fromPackages` resolves each package from `__dirname` the way node does. A BUILT or published package
(a Docker image relinking `node_modules/@myorg/*` onto `dist/`) holds the files beside its
`package.json`; a workspace SOURCE directory (pnpm linking onto `libraries/...` for local dev and
vitest) holds a `project.json`, and the files are read from the outputPath of the target its
`openapi-generate` dependsOn (its `build`) — which is why nx.json's targetDefaults for a server's `test`
(and `build`) must dependsOn `^openapi-generate`; `validate-nx-wiring` prints the exact line.

`McpToolRegistry` (built by the `McpToolset` constructor) FAILS FAST at boot, naming every directory the catalogs were read from, when a bound
contract has no catalog, a catalog's contract is not bound, or a tool name is declared twice — and when
a registered `@WpMcpTool` is absent from its contract's catalog: a tool the build never saw is a tool
whose schema nobody checked. Tool arguments and structured output are
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
change. WHICH tools are served is the `McpToolset`, not the config:

```ts
const config = new WpMcpServerConfig()
    .setName('my-server')
    .setTitle('My Product')
    .setDescription('Search and manage My Product accounts from any MCP client.')
    .setWebsiteUrl('https://www.example.com/my-product')
    .setVersion('1.0.0')
    .setResource('https://api.example.com/mcp')
    .setAuth([
        mcpOAuth(authority, ['https://login.example.com'], ['tools'],
                 McpAccessTokenFormat.opaquePrefix('wpmcp_'), 15 * 60),
    ]);

// The tools/call error translator is a PROCESS-GLOBAL, not a member of this config:
McpRegistry.setErrorTranslator(new MyMcpErrorTranslator());
```

Each setter validates its own value immediately and names itself in the failure: `setResource(...)`
and every `mcpOAuth(...)` authorization server must be an absolute URL, because they are compared
against a token's audience and issuer. `mcpOAuth(...)`'s `maxAccountValidationAgeSeconds` defaults to one
hour and is capped there. `setCredentialVerifiers(router.credentialVerifiers())` is required once
`setAuth([...])` holds any `@WpAuth` mode.

`setTitle`, `setDescription` and `setWebsiteUrl` are REQUIRED and are sent on `initialize`'s
`serverInfo` (and on every modern-era result's `io.modelcontextprotocol/serverInfo` meta) as
`title`, `description` and `websiteUrl`:

| setter | `serverInfo` field | validation |
|---|---|---|
| `setTitle(title)` | `title` (MCP 2025-06-18) | one line, at most 100 characters |
| `setDescription(description)` | `description` (MCP 2025-11-25) | non-empty, at most 2000 characters |
| `setWebsiteUrl(url)` | `websiteUrl` (MCP 2025-11-25) | absolute `https://` URL |

The limits are the Claude Connectors Directory's listing Name and Description limits. The app sets all
three because the server cannot derive them: it does not read the OpenAPI manifest at runtime, and one
server may bind contracts from several api libraries. `websiteUrl` is a page a human reads (the product
homepage or docs site), so it is never derived from `setResource` — that is the MCP endpoint, not a
website. There are no defaults; a missing one fails `bind(...)` naming the setter, like `setName`.

`setIcons(...)` is the only optional setting (the error
translator is process-global, on `McpRegistry`); everything else is required and
`WpMcpServer.bind(...)` fails at startup listing **every** missing setter
(`WpMcpServerConfig is missing setResource(...)`). That is deliberate: with `mcpOAuth(...)`, a
misconfigured audience or issuer otherwise surfaces as a first-request `401 + WWW-Authenticate`, which is
the OAuth discovery signal, so a client answers it by re-authenticating and failing again — forever.

Applications supply the toolset, the endpoint path, and deployment topology. There is no
framework-owned `/mcp` path:

```ts
const toolset = new McpToolset(
    [
        McpApiBinding.local(OrdersApi, apiFactory),
        McpApiBinding.remote(RemoteOrdersApi, () => remoteOrdersClient),
    ],
    catalogs,
    apiFactory.authorizationService(),
    [Mcp.DEFAULT],
);
const mcp = new WpMcpServer(config, toolset);
mcp.bind(expressApp, new McpBindOptions(connectorConfig.endpointPath, McpDeployment.singleProcess()));
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

The caller's credential is verified identically on both legs, at the `bind(...)` HTTP boundary, before
the SDK is involved — the era is the SDK's decision, the authentication is not.

The official MCP v2 server and Node adapter own JSON-RPC validation for both eras, JSON versus
request-scoped SSE responses, backpressure, cancellation, keepalives, and subscriptions. Webpieces
owns the Express path, root `RequestContext`, authentication boundary, schema-derived tool registry,
and dispatch through the normal API proxy.

Import `MCP_INVOCATION_CONTEXT`, `McpInvocationContext` and the `McpProgressReporter` type from
`@webpieces/core-util`; these lightweight contracts are no longer exported by `@webpieces/mcp-server`.
They use the existing `RequestContext`, with no additional context scope or MCP SDK dependency.

During a tool invocation, `RequestContext.getTrusted(MCP_INVOCATION_CONTEXT)` exposes the verified
JSON-RPC ID, tool/user/role facts, the official SDK cancellation `AbortSignal`, and (when the client
supplied `_meta.progressToken`) a `reportProgress(...)` callback. Progress remains related to that
one request and causes the official handler to select request-scoped SSE; closing that response
aborts the same signal. The context key has no HTTP header and is never propagated as caller input.

Local bindings require explicit tool exposure and valid common authorization. They pass a token-free
`InvocationAuthentication` through `ApiFactory.createInvocationApiClient`, preserving the ordinary
logging, authentication and authorization filters. The proof identifies the actual endpoint and
original verified ingress scope. No endpoint JWT is minted or parsed and no GUI `JWT_HOOK` is required.
Remote bindings declare `oidcSameProject()`, `oidcSvcs(...)` or `sharedSecret(...)` network credentials. The generated Node
client chooses its service mechanism before forwarding verified delegated facts; the MCP bearer never
becomes a downstream credential.

`McpDeployment.singleProcess()` uses an in-memory invalidation bus and makes that limit explicit.
Distributed deployments must use `McpDeployment.distributed(sharedBus)`. List responses have a bounded
TTL, registry metadata contains a surface-derived revision, `toolsChanged()` publishes a
level-triggered invalidation, and `close()` drains active response streams. A reconnecting client must
re-listen and refresh its authoritative lists; notifications are not a durable or replayable event log.

With `mcpOAuth(...)`, the authority verifies issuer, signature/token state, expiry, scopes, the exact
resource URI, and current account state. Neither served era keeps a session here, so the credential is
verified once per POST at the `bind(...)` HTTP boundary, before the SDK is involved; tool handlers never
re-verify it. A rejected token must be thrown as `ApiUnauthorizedError` (answered 401 +
`WWW-Authenticate`); any other throw from the authority is an implementation failure (500). MCP access
tokens are capped at 30 days.

## Principal, policy and request context

`VerifiedMcpCredential.caller` is the application's `AuthenticatedCaller` resolved from current account
facts. `principalRoles` is derived from that caller, a public hard cut from the old listing-role field.
The framework publishes its canonical USER_ID and JSON-array USER_ROLES; custom trusted facts come from the verified caller entries. Security metadata
(issuer, exact resource, scopes, issuance/expiry and account validation time) remains on the credential.

The framework publishes the caller's trusted entries and `llm` surface immediately after verification,
then reconciles inbound trusted headers using the same operation as ordinary HTTP. Contradictory or
unvouched identity/surface headers are rejected. The common `AuthorizationService` governs the request's authorized
tool view before SDK processing; only explicit `ApiForbiddenError` denials hide tools. Policy/datastore
failures propagate to the safe ingress boundary. Documentation, synchronous SDK schema lookup and call
name resolution all use that view. The dispatcher independently checks the same policy before input
validation and invocation. A hidden tool is indistinguishable from an unknown name and triggers no
schema validation or binding invocation.

Each HTTP POST has one transport-owned `RequestContext.run`, including malformed-body failures. Local
invocation opens no detached/nested scope and retains the original transport request, request/action IDs,
custom context and downstream response-header accumulation. Its immutable `InvocationAuthentication`
is carried on that invocation's proxy/MethodMeta, never on a mutable ambient credential slot. Normal
receiving endpoint authorization runs against the same canonical trusted facts. A captured/restored
snapshot cannot reuse the local proof. GUI HTTP requests verify their own bearer normally. Remote
bindings authenticate their own hop before accepting delegated facts; another HTTP process has its
own scope. `SERVICE_ONLY` requires actual current-hop machine evidence, even when the surface is `llm`.

See [the authorization migration and release order](../../../docs/authorization-migration.md).


## Error boundary

`WpMcpErrorTranslator` is the one place a failure becomes an MCP reply, mirroring
`WebpiecesDefaultErrorTranslator`: an error in, the exact wire shape out. Each entry point has exactly one catch
that delegates to it. HTTP ingress uses one translating wrapper and all SDK callbacks use one shared catch implementation with explicit protocol/tool stage; the dispatcher and invokers have none. Classification is
the shared `ApiErrorBoundary.encode` rule (a non-`ApiError`, or a caller-local `ApiConnectionError`,
publishes as kind `implementation`). The boundary never substitutes an object for the thrown error,
so an app's `McpErrorTranslator` can `instanceof` its own error classes.

There is ONE method per BOUNDARY, named for the boundary it guards. They cannot be one shape — the
MCP spec fixes each. The shared SDK catch selects protocol versus tool rendering by operation/stage:

| Boundary | Method | Reply |
|---|---|---|
| before the SDK: bearer, `Origin`, malformed body | `toBearerBoundaryResponse(error): HttpResponseDto<McpHttpErrorBody> \| HttpResponseDto<OAuthErrorBody>` | HTTP 401 + `WWW-Authenticate` / 403 / 400, anything else 500; an `OAuthProtocolError` gets the RFC 6749/6750 body at its own status |
| `tools/list` | `toListError(error): never` | throws JSON-RPC `-32602` (bad request) or `-32603` `Internal Error` |
| `tools/call`, tool found: bad arguments, endpoint policy denial, JWT/OIDC mint failure, any local or remote failure, output-schema or serialization failure | `toToolCallResult(error): CallToolResult` (delegates to `McpRegistry.getErrorTranslator().toWire`) | `isError: true` result |
| `tools/call`, unknown or hidden tool name (including a dispatcher policy recheck denial) | `unknownTool(name)` | JSON-RPC `-32602` `Unknown tool: <name>` |

The pre-SDK boundary produces a VALUE like every other API in the framework and `WpMcpServer` writes
it through the same `ExpressResponseWriter` the ordinary HTTP path uses — it does not hand-roll
`res.status(...).json(...)`. The body stays JSON-RPC shaped because an MCP client expects that — except for an `OAuthProtocolError`
(an authorization service refusing the bearer with `invalid_token` / `insufficient_scope`), which is
answered in the RFC shape by `OAuthErrorResponse`, keeping this server's challenge on a 401;
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

The one addition is for failures that are THIS server's bug. Before `tools/list` or `tools/call`
hands an `implementation`-kind failure to the translator, `WpMcpServer` writes one `log.error` with
the error's stack and `requestId=<id>` — the same id the caller is told to give support (#1055). An
MCP output-schema violation needs it most: it is raised after the controller returned, so the only
`LogApiCall` line for that call reads `resp-SUCCESS`. Caller-kind failures (bad-request, end-user,
dependency, ...) get no such line.

`subscriptions/listen` is served entirely by the SDK's listen router, so Webpieces has no handler there.

`requestId` comes from `RequestContext` and the JSON-RPC id and tool name from the request scope,
so none of the three methods takes a correlation parameter — the deleted `McpFailureScope` was a copy
of context the renderers can already read.

The default `content[0].text` is JSON with an explicit `{ "error": { ... } }` envelope, because some
clients display only content and hide the top-level MCP `isError`. The nested error carries the
precise `kind`, a small ownership `category`, explicit `retry` guidance, a safe message, and the
`requestId`. It may also carry safe fields such as `field`, `callerMessage`, `errorCode`,
`retryAfterSeconds`, and `statusCode`. It never repeats `isError` inside the content.

MCP keeps no retry table of its own: the advice is a function of the ONE outcome
`ApiRegistry.classify` gives every reader (`RetryStrategy`, `LogApiCall`), the endpoint's
operation, and `retryAfterSeconds`. Implementation failures are `category: "bug", retry: "never"` and
tell the caller to give the request ID to support; operator details remain redacted. Generic
dependency failures are also non-retryable, and so is `retries-exhausted` (`category: "dependency",
retry: "never"`): this service already retried that dependency, so the model must not retry it again.
A `CallOutcome.TRANSIENT_FAILURE` — gateway, timeout, unavailable, throttling, backoff, or anything an
app's classifier marks transient — is temporary, but a retry is described as safe only for a `read`
or `write-idempotent` endpoint. A `write` reports `retry: "unsafe-outcome-unknown"`, because a lost
response does not prove the write failed to commit.

Every reply carries the requestId so a user can quote it: `_meta["webpieces/requestId"]` on every
`tools/call` result (success or `isError`), `requestId` in the `isError` payload, and
`error.data.requestId` on JSON-RPC and HTTP-boundary errors.

### The application's own `tools/call` translation

An app owns its error taxonomy and owns how those errors should be explained to a model, so a
registered translator REPLACES the webpieces default for every `tools/call` failure — the same
convention `ExpressWrapper.handleError` applies on the HTTP path. Register one with
`McpRegistry.setErrorTranslator(...)`: ONE process-global per protocol, mirroring `ApiRegistry`
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
An MCP tool result is read by a MODEL, never decoded back into an exception — even through
`WpMcpInMemory` / `WpMcpRemote`, which are the SDK's own `Client` handing the agent the `CallToolResult`
as-is — so there is no return path for webpieces to translate. The pair is one-directional by nature,
not by omission.

The verifier's `accountValidatedAtEpochSeconds` must represent an authoritative enabled/revoked and
role/scope read. The bridge enforces a maximum one-hour decision age; per-request reads are preferred so
offboarding and role changes take effect on the next call. JWT access-token implementations must enforce
an explicit algorithm allowlist plus issuer, exact audience/resource, expiry, type/version, and key
rotation metadata. Opaque tokens remain valid implementations of the same authority contract.

`protectedResourceMetadata()` returns the resource metadata an HTTP adapter can publish at the
well-known OAuth protected-resource endpoint. OAuth token issuance remains pluggable.

### Refusing in the RFC shape from your own OAuth routes

Token issuance, client registration and the authorization endpoint are the app's own express routes.
Refuse there with `OAuthProtocolError` (from `@webpieces/core-util`) and mount
`OAuthExpressErrorHandler` (from `@webpieces/http-server`) as the error handler, so the OAuth client
gets `{ "error": "invalid_grant", "error_description": "..." }` at the RFC status with the right
`WWW-Authenticate`, and the refusal is logged at INFO rather than as a server ERROR:

```typescript
const oauthErrors = new OAuthExpressErrorHandler();
app.post('/oauth/token', urlencoded({ extended: false }), async (req, res) => {
    if (req.body.grant_type !== 'authorization_code') {
        throw new OAuthProtocolError(OAuthErrorCode.UNSUPPORTED_GRANT_TYPE, 'only authorization_code');
    }
    // ...
}, oauthErrors.middleware);

// authorization endpoint: errors go back as a redirect, never a status (RFC 6749 §4.1.2.1)
res.redirect(302, new OAuthAuthorizationErrorRedirect(
    validatedRedirectUri, OAuthErrorCode.ACCESS_DENIED,
    typeof req.query.state === 'string' ? req.query.state : undefined, 'The user declined').toUrl());
```

An authorization service that throws an `OAuthProtocolError` (`invalid_token`, `insufficient_scope`)
while this server verifies a bearer is rendered the same way at the MCP boundary, and a 401 without
its own challenge keeps this server's `resource_metadata` challenge. The status is derived from the
code; only `invalid_client` may choose 400 or 401, and the constructor's overloads make any other
status a compile error. See `docs/portable-ipc-and-errors.md` for the full vocabulary.

That endpoint's URL is `WpMcpServerConfig.resourceMetadataUrl` — RFC 9728 §3.1 path insertion, so
`https://host/mcp` publishes at `https://host/.well-known/oauth-protected-resource/mcp` — and it is the
value of `resource_metadata` in the 401 `WWW-Authenticate` challenge. RFC 9728 §5.1 defines that
parameter as the URL of the metadata DOCUMENT, never the resource identifier itself. The framework
mounts no `.well-known` route; the app publishes the document there.

## Tool profiles and independent endpoints

Profile membership partitions tool exposure; account roles still belong exclusively to
`@WpAuthorization`. Selecting an admin profile never grants admin authority. Import `Mcp` and
`WpMcpTool` from the browser-safe `@webpieces/core-util` package:

```ts
@WpMcpTool('learner_get_passages') // only Mcp.DEFAULT
@WpMcpTool('admin_list_users', { profiles: ['admin'] }) // only admin
@WpMcpTool('shared_tool', { profiles: [Mcp.DEFAULT, 'admin'] })
```

Each declaration also needs the usual endpoint, DTO, authentication, and authorization declarations,
and a `@summary` line in the method's JSDoc for its title.
One argument, an omitted `profiles` property, and explicit `[Mcp.DEFAULT]` all select only the base
group. An explicit list replaces that membership; it never implicitly adds the base group.
Identifiers match `[a-z][a-z0-9-]{0,63}` (1–64 lowercase ASCII letters, digits or hyphens, starting
with a letter). `Mcp.DEFAULT` reserves `default` for the base group. Empty lists, duplicates, unknown
option keys, whitespace, paths, and invalid identifiers are rejected. Lists are snapshotted and sorted.

Configure one independent `WpMcpServer` per mount, each over its own `McpToolset` with the same
bindings, complete catalogs, and receiving router's `AuthorizationService` — the profiles are the
toolset's REQUIRED fourth argument:

```ts
const toolsetFor = (profiles: McpToolProfiles): McpToolset =>
    new McpToolset(bindings, catalogs, router.authorizationService(), profiles);
new WpMcpServer(baseConfig.setResource('https://api.example.com/mcp'), toolsetFor([Mcp.DEFAULT]));
new WpMcpServer(adminConfig.setResource('https://api.example.com/mcp/admin'), toolsetFor(['admin']));
new WpMcpServer(bothConfig.setResource('https://api.example.com/mcp/both'), toolsetFor([Mcp.DEFAULT, 'admin']));
```

Bind each instance with `McpBindOptions.endpointPath` equal to its resource path: `/mcp`,
`/mcp/admin`, or `/mcp/both`.
A combined selection is the union, with shared tools listed once in stable name order. Further groups
such as `course-authoring` work identically. No caller-controlled profile route or hint exists.
The toolset snapshots its groups at construction; they are fixed for its lifetime.

With `mcpOAuth(...)`, publish each instance's `protectedResourceMetadata()` at its configuration's `resourceMetadataUrl`,
e.g. `/.well-known/oauth-protected-resource/mcp/admin`. Token authorities must verify the fixed exact
resource, trusted issuer, expiry, scopes, and fresh account state. A `/mcp` token is rejected on
`/mcp/admin`. Never derive audiences from Host headers. OAuth consent, grants, and connector setup
remain application-owned; framework tests do not establish Claude.ai's simultaneous credential behavior.

All supplied contracts/catalogs are validated before profile projection, including excluded entries.
Discovery, schema lookup, and execution share the same profile-and-authorization view. Membership
is catalog metadata, never a nonstandard MCP Tool field. Catalog entries now require `profiles`;
artifacts from before this change are rejected with a cure to rebuild the contract library's
`openapi-generate` target. Regenerate catalogs when upgrading; there is no schema reflection fallback.
# Product icons

Configure optional standard MCP implementation icons through the fluent config:

```ts
import { McpIcon, WpMcpServerConfig } from '@webpieces/mcp-server';

const config = new WpMcpServerConfig()
    .setName('my-product')
    .setTitle('My Product')
    .setDescription('Search and manage My Product accounts from any MCP client.')
    .setWebsiteUrl('https://www.example.com/my-product')
    .setVersion('1.0.0')
    .setResource('https://api.example.com/mcp')
    .setIcons([
        new McpIcon(
            'https://api.example.com/branding/product-v1-128.png',
            'image/png',
            ['128x128'],
            'light',
        ),
    ]);
// Supply the required setAuth([...]) as usual.
```

`setIcons` accepts standard SDK `Icon` descriptors (`src`, optional `mimeType`, `sizes`,
and `theme`) as well as `McpIcon` instances. Multiple descriptors support resolutions and
light/dark backgrounds. Sizes use positive `widthxheight` values or `any`. The configuration
copies and freezes descriptors, including size arrays; binding captures that snapshot, so later
caller mutation or configuration setters cannot change a running bridge's icons. Omitting icons
leaves the metadata absent; an explicitly empty array advertises no icons.

Host the example PNG at a publicly readable HTTPS URL on the MCP resource's own origin.
It must require no cookie, bearer header or other credentials, and must not redirect to another
origin or scheme. Hosting and image contents are application-owned: this package adds no static
asset route and never fetches icons on startup or during requests. HTTPS URLs containing user
credentials, other URI schemes and malformed descriptors are rejected. Resource-origin validation
runs at bind time, so setter order does not matter. Clients must still enforce safe redirects,
image parsing and resource limits when fetching/rendering untrusted image bytes.

Alternatively embed a non-empty base64 image data URI, for example
`new McpIcon('data:image/png;base64,...', 'image/png')` with actual base64 image bytes in place
of `...`. PNG is the broadly compatible choice. SVG support is optional for clients and requires
additional sanitization; valid metadata does not guarantee safe image contents.

The SDK renders icons in legacy `initialize.result.serverInfo.icons` and current
`result._meta['io.modelcontextprotocol/serverInfo'].icons` (2026-07-28). Advertising icons
does not guarantee every MCP client renders them or invalidate a provider's branding cache.
See the [MCP icon specification and security guidance](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/basic/index.mdx#icons).

