# @webpieces/openapi-generator

Render a webpieces API contract to **OpenAPI 3.1.0**.

```bash
wp-openapi --manifest path/to/openapi.manifest.json --out path/to/generated [--format json|yaml|both]
```

## Which documents you get is a property of your CONTRACTS

```typescript
@ApiPath('/stores')
@ApiType(SVC_TO_SVC, EXTERNAL_CUSTOMER)     // which documents this contract feeds
export abstract class StoreApi { ... }
```

| `@ApiType` value | file | contents |
|---|---|---|
| `SVC_TO_SVC` | `full-private-openapi.json` | every method, hidden ones included, plus an internal-use-only line in `info.description`. Nothing renders it for humans |
| `EXTERNAL_CUSTOMER` | `public-openapi.json` | the customer contract, minus every `{ hidden: true }` method |
| `MCP` | `mcp-openapi.json` | the same contracts with the `x-mcp-*` extensions an MCP generator reads |

**A document no contract declares is not written.** No `@ApiType` at all means `SVC_TO_SVC` only —
fail-closed: a contract reaches customers by SAYING SO, so `grep -rn EXTERNAL_CUSTOMER` is your entire
customer-facing surface on one screen.

`--format` picks the serialization of whichever documents exist, and defaults to `both`.

`diff full-private-openapi.json public-openapi.json` is the complete list of what you do not show a
customer. Commit both, and hiding a method shows up in the PR that hides it.

## Hiding ONE method

```typescript
/**
 * Rebuilds a store's menu cache.
 *
 * Not published: an operator tool, and the customer contract has no concept of our cache.
 */
@Endpoint(POST, '/reindex', WRITE, RPC, { hidden: true })
```

The reason goes in the JSDoc — where the rest of the endpoint's documentation already lives. The
method is absent from `public-openapi.json`: no path, no operation, no schema, no prose, and nothing
announcing that anything was withheld.

**Hiding is a documentation decision and never an access-control one.** The route is still served and
still demands whatever credential it declares.

## The manifest

It carries exactly what is **not a property of the code**:

```json
{
    "title": "Example Orders API",
    "version": "1.0.0",
    "descriptionFile": "description.md",
    "servers": [{ "url": "https://api.example.com", "description": "Production." }],
    "apis": [
        { "entry": "src/OrdersApi.ts", "tag": "Orders" },
        { "entry": "src/EventsApi.ts", "tag": "Webhooks", "kind": "webhook" }
    ],
    "securitySchemeNames": ["PartnerApiKey", "PartnerOrganization"],
    "errors": {
        "entry": "src/ApiErrors.ts",
        "type": "ApiErrorResponse",
        "responses": [{ "status": "400", "description": "The request failed validation." }]
    },
    "responseHeaders": [
        {
            "entry": "src/ResponseHeaders.ts",
            "nameConstant": "REQUEST_ID_HEADER",
            "description": "Correlates this response with our logs."
        }
    ]
}
```

Every path is relative to the manifest's own directory.

**The ORDER of `apis[]` is the published sidebar order.** Alphabetising it is not a cleanup.

**`securitySchemeNames` holds the published KEYS only.** The schemes themselves, and the AND-ed
`security` requirement, are DERIVED from the contract's `@WpAuthApiKey(regime, credentials)`. A
`securitySchemes` block in the manifest would be a second copy of header names the running server
never reads, and nothing could contradict it.

**`responseHeaders` names a CONSTANT, never a header string.** JSON cannot import, so a literal there
is a copy that a rename leaves silently stale. The generator folds the const and hard-fails if it
cannot.

## MCP

`MCP` in `@ApiType` requires `@WpMcpTool` on at least one method, and `@WpMcpTool` on a contract that
does not declare `MCP` is an error. Membership has one spelling.

The agent reads the SAME `description` a human does — the method's JSDoc, byte for byte.
`@WpMcpTool`'s own `description` field is never read: two authored copies of one paragraph drift the
first time somebody edits one. The tool carries only what JSDoc cannot say — the stable protocol name.
`readOnlyHint`, `destructiveHint` and `idempotentHint` are computed from the endpoint's declared
`operation`; `openWorldHint` comes from `{ openWorld: true }` on the endpoint.

## It refuses to publish a field it has no schema for

A field the model could not map renders as an empty schema, which in JSON Schema means "anything".
`wp-openapi` exits non-zero instead, naming the JSON pointer of every one, and writes nothing. There
is no flag to switch that off — the cure is at the contract, by naming the type.

## Worked example

`apps/app-example/partner-api` in this repo: a real contract, its manifest, the committed documents,
and a spec that regenerates and diffs them.

## Dependencies

`typescript`, `@webpieces/api-doc-model` and `@webpieces/core-util`. No nx, no repo paths, no app
types.
