# @webpieces/openapi-generator

Render a webpieces API contract to **OpenAPI 3.1.0**.

```bash
wp-openapi --manifest path/to/openapi.manifest.json --out path/to/dist [--format json|yaml|both]
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
customer. Neither is committed — both are build output (see "In an nx workspace" below); diff the two
the build wrote when you need that list.

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
`security` requirement, are DERIVED from the contract's `apiKey(regime, credentials)`. A
`securitySchemes` block in the manifest would be a second copy of header names the running server
never reads, and nothing could contradict it.

**`responseHeaders` names a CONSTANT, never a header string.** JSON cannot import, so a literal there
is a copy that a rename leaves silently stale. The generator folds the const and hard-fails if it
cannot.

## DTO libraries: chained documents, one owner per schema (#1058)

A schema is defined in exactly ONE document: the one belonging to the package whose source declares
the TypeScript type (the nearest `package.json` above the declaration). A contract document defines its
own package's types and **references** every other package's with a package-qualified `$ref`:

```json
{ "$ref": "@myorg/lang-api-dtos/components.openapi.json#/components/schemas/PassageItemDto" }
```

So a DTO library publishes a **components-only** document. Its manifest declares `"kind": "components"`
and names entry files instead of contracts:

```json
{ "kind": "components", "title": "Lang DTOs", "entries": ["src/index.ts"] }
```

`wp-openapi` then writes `components.openapi.json` — `openapi`, `info` (whose `version` IS the package
version), `x-webpieces-id` (the URI above; OpenAPI 3.1's root admits no `$id`) and `components.schemas`
holding **every type the library exports and declares**. A DTO library that uses another DTO library
references it the same way, so chains have any depth. It needs `--format json` or `both`.

The referenced documents are found by the same package lookup `McpToolCatalog.fromPackages` uses:
node resolution from the manifest, then the file beside a built package's `package.json`, or — for a
workspace source directory — the `outputPath` of the target its `openapi-components-generate` dependsOn.

**It FAILS CLOSED.** A `full-private` / `public` document that reaches a type declared in a package
publishing no components document is refused, naming the type, its package and the fix: move the type
into a DTO library (as a `…Dto` string enum when it is a literal union), or give that package a
components document (in nx: tag it `generate:openapi-components`). There is no allow-list. A referenced schema missing from an existing document is
refused as stale. Two DIFFERENT types of one name in one package are refused too; two packages'
same-named types are simply two schemas in two documents.

Inheritance is FLATTENED in every form — a base declared in another package contributes its fields;
there is no `allOf`.

**Every split document has a `*.bundled.json` sibling** (`public-openapi.bundled.json`, …) with every
schema pulled into its own `components.schemas` and no external reference, for code generators,
gateways and docs sites that read one file. A schema keeps its name there unless two packages' types of
one name meet, when the other package's is qualified (`myorg.lang-api-dtos.LocalizedDescriptionsDto`).

**`mcp-openapi.json` and the MCP tool catalogs never reference anything** — they inline every schema
from any package, exactly as before, and require no components document anywhere.

## MCP

`MCP` in `@ApiType` requires `@WpMcpTool` on at least one method, and `@WpMcpTool` on a contract that
does not declare `MCP` is an error. Membership has one spelling.

The agent reads the SAME `description` a human does — the method's JSDoc, byte for byte. Two authored
copies of one paragraph drift the first time somebody edits one, so `@WpMcpTool('search_stores')`
carries only what JSDoc cannot say: the stable protocol name. `readOnlyHint`, `destructiveHint` and
`idempotentHint` are computed from the endpoint's declared `operation`; `openWorldHint` comes from
`{ openWorld: true }` on the endpoint.

Alongside `mcp-openapi.json`, a run writes ONE **`mcp-<ContractClass>-tools.json`** per contract that
declares `MCP` and has at least one `@WpMcpTool` (e.g. `mcp-PartnerOrdersApi-tools.json`). Those are
not documents: they are the RUNTIME catalogs `WpMcpServer` boots from, so the schema an agent is shown
in `tools/list` and the schema the server validates a call against are the same bytes. One file per
contract because a server binds contracts, and checks each binding against exactly its own contract's
file. `--format` does not apply to them.

## It refuses to publish a field it has no schema for

A field the model could not map renders as an empty schema, which in JSON Schema means "anything".
`wp-openapi` exits non-zero instead, naming the JSON pointer of every one, and writes nothing. There
is no flag to switch that off — the cure is at the contract, by naming the type.

## Worked example

`apps/app-example/partner-api` in this repo: a real contract, its manifest, golden documents under
`src/__tests__/goldens/`, and a spec that regenerates and diffs them. The chained form is proven by
`src/__tests__/ChainedComponents.spec.ts` here: a three-level chain (contract → DTO library A → DTO
library B), every document checked by an OpenAPI 3.1 validator.

## In an nx workspace

Inside nx, nobody chooses `--out`. A DTO library tagged `generate:openapi-components` gets an inferred
`openapi-components-generate` target the same way, and every generating target that references one
dependsOn `^openapi-components-generate`. Tag the api library `generate:openapi` and the
`@webpieces/nx-webpieces-rules` plugin infers an `openapi-generate` target that writes into the
outputPath of the library's `build` (the @nx/js:tsc target it dependsOn), so the documents are packed and published inside the api
library's package, and are never committed. It runs THIS package from the consumer's `node_modules`
and refuses one older than it needs. See `.claude/rules/api-docs.md` in webpieces-ts.

## Dependencies

`typescript`, `@webpieces/api-doc-model` and `@webpieces/core-util`. No nx, no repo paths, no app
types.
