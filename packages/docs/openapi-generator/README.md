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
    "summary": "Read and cancel the orders placed at your stores.",
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
        "responses": [
            { "status": "400", "description": "The request failed validation." },
            { "status": "401", "description": "The api key is not valid.", "requiresAuth": true }
        ]
    },
    "responseHeaders": [
        {
            "entry": "src/ResponseHeaders.ts",
            "contextKey": "REQUEST_ID_KEY",
            "required": true,
            "description": "Correlates this response with our logs."
        }
    ]
}
```

Every path is relative to the manifest's own directory.

The API itself has the same three forms an operation has (#1296): `title` is `info.title`, the
REQUIRED `summary` — one line, at most 200 characters, the Claude Connectors Directory's one-liner
limit, so the same text can be pasted there — is OpenAPI 3.1's `info.summary`, and `descriptionFile`
is `info.description`. A manifest with no `summary`, an empty one, a second line or more than 200
characters is refused, naming the key. A `"kind": "components"` manifest takes no `summary`: a DTO
library's document is not an API anybody lists.

### Source suffixes and published schema names

An optional `schemaNames` list controls published type names independently of source
validation. It works in contract manifests and `"kind": "components"` manifests:

```json
"schemaNames": [
  { "paths": ["../keep-my-names/**"], "stripSuffixes": [] },
  { "paths": ["../partner-apis/**", "../shared-dtos/**"], "stripSuffixes": ["Dto"] }
]
```

Globs match the type's declaring file, relative to the manifest's directory. The
first matching entry wins; no match or an explicit empty list preserves the name.
Only one exact, case-sensitive trailing suffix is removed, in configured order.
`OrderDto` becomes `Order`; `Dto` alone and `OrderDTO` remain unchanged.

The same published names are used for schema keys, every reference and discriminator
mapping, bundled documents, MCP tool schemas, and streaming schemas. Source names
remain available to validation and diagnostics. If stripping makes two reached
declarations share a published name, generation fails naming both declarations and
their locations. Existing unstripped package-qualified homonyms remain supported.

Configure matching policies on **every producer and consumer** in a components
chain. The downstream generator checks that the upstream document actually exports
the expected schema name; a missing or inconsistent policy fails generation.

This combines with `required-type-suffix`: use an entry with `exempt: true` to
preserve published source names, or set `exempt: false` and enforce `Dto` gradually with
`NEW_AND_MODIFIED_CODE` while stripping it from generated documentation. The
chained-components regression test renames source declarations and checks that all
generated OpenAPI and MCP artifacts remain byte-identical.

Every suffix-enforcement entry requires an explicit `exempt` boolean and non-empty
`suffixes`, including exempt entries. Retaining the suffixes records the policy that
re-enabling the entry will enforce. `suffixes: []` is rejected with migration advice.
For example: `{ "paths": ["published/**"], "suffixes": ["Dto", "Api"], "exempt": true }`.

**The ORDER of `apis[]` is the published sidebar order.** Alphabetising it is not a cleanup.

**`securitySchemeNames` holds the published KEYS only.** The schemes themselves, and the AND-ed
`security` requirement, are DERIVED from the contract's `apiKey(regime, credentials)`. A
`securitySchemes` block in the manifest would be a second copy of header names the running server
never reads, and nothing could contradict it.

**Header names come from a `ContextKey`, never a string (#1249).** Each header is defined ONCE, as a
`ContextKey.trusted(...)` / `ContextKey.untrusted(...)`, and every surface names that key:

- an api-key credential is `{ in: 'header', key: MyKeys.API_KEY }` — the generator follows the key
  (through imports, `!`, `as`, a class's `static readonly` or an object's property — and, for a key
  from a published package, into the compiled `.js` beside its `.d.ts`) to its factory
  call and reads its `httpHeader`;
- `responseHeaders[].contextKey` names an exported ContextKey in `entry` — the export, or a dotted
  path into one (`"OneTabletKey.TX_ID"`) — and the generator reads its `responseHeader`. The old
  `nameConstant` is refused with an error naming `contextKey`.

JSON cannot import, so a literal there would be a copy that a rename leaves silently stale. When a
key cannot be followed to its definition, or declares no such header, generation hard-fails QUOTING
the expression.

**Every response header rides every response the operation declares** — the success response
AND each `errors.responses[]` entry listed on it (so an auth-only 401 left off a public operation
carries nothing there, because it is not there). The server stamps the header on every response, and
for a correlation id the failing response is the one a partner most needs to quote back. A webhook
takes none of them: it is served by the partner, not by us.

**`operationIds` is optional and defaults to `"contract_method"` (#1270, #1283).** `operationId` is
what openapi-generator, Kiota, NSwag and the rest name the METHOD in every client a partner generates,
so changing its spelling renames every method in every partner's SDK:

| value | publishes | uniqueness |
|---|---|---|
| `"contract_method"` (the default) | `OrdersApi_fetchOrders` | by construction |
| `"method"` | `fetchOrders` | checked: two operations of one document (routes and webhooks alike) sharing an id is a HARD FAILURE naming both |

Omit the key for a new API: `"contract_method"` is the spelling every release before #1270 published,
and it keeps working as contracts grow (two contracts that each have a `fetch` never collide).
`"method"` is the opt-in for a document that has already published bare names and must keep them.
Any other value is refused with an error naming the key and both choices.

**`responseHeaders[].required`** is rendered verbatim on the header object; omitted, the document
does not state it (OpenAPI reads that as `false`).

**`errors.responses[].requiresAuth: true`** marks a failure only an authenticated operation can have
(a 401): it is left off every operation whose auth is `@WpAuthPublic`. Omitted means `false` — the
response is listed on every operation.

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

## Single-use request/response wrappers are inline (#1303)

A class used ONLY as one operation's request body or one operation's success response is written
inline at that operation instead of as `components.schemas.<Name>` + `$ref`:

```json
"schema": {
    "type": "object",
    "title": "FetchReportCoverageRequest",
    "description": "Which report's coverage to fetch.",
    "properties": {}
}
```

`title` is the published name, which client generators (openapi-generator, NSwag, Kiota) name the
inline model from, so a partner's SDK keeps `FetchOrdersRequest` rather than `FetchOrders200Response`.
An empty class keeps `"properties": {}`, which a client generator needs to emit an empty class.

"Only" is counted over every route and webhook of every contract in the manifest — not per document —
so a wrapper a public method shares with a hidden one stays a component in both. A wrapper used by two
or more operations, nested in any other schema, used as the error body, or declared in ANOTHER package
(which owns its schema in its own `components.openapi.json`) stays a component, as do enums, unions and
every shared noun. The split documents and their `*.bundled.json` siblings inline; `mcp-openapi.json`
keeps every wrapper a component. An inlined wrapper still needs its JSDoc description.

## The public document carries no `x-webpieces-*` key (#1303)

`public-openapi.json` and `public-openapi.bundled.json` are the partner's contract, so they carry only
standard OpenAPI: a partner's authentication is `components.securitySchemes` + `security`, and a
webhook is an entry of `webhooks:`. `x-webpieces-authentication` — whose `arguments` are the TypeScript
identifiers passed to `@WpAuth`, private names a partner cannot use — and `x-webpieces-webhook` appear
in `full-private-openapi.json` and `mcp-openapi.json` only.

## MCP

`MCP` in `@ApiType` requires `@WpMcpTool` on at least one method, and `@WpMcpTool` on a contract that
does not declare `MCP` is an error. Membership has one spelling.

The agent reads the SAME `description` a human does — the method's JSDoc, byte for byte. Two authored
copies of one paragraph drift the first time somebody edits one, so
`@WpMcpTool('search_stores')` carries only what JSDoc cannot say: the stable protocol name — 1-64
characters of `[A-Za-z0-9_-]`, refused at generation otherwise, every offender named in one run, because
the Claude Connectors Directory refuses a longer one (#1296). The title is the method's `@summary`
(below): each catalog entry carries it as `title`, `tools/list` publishes it as `title` AND
`annotations.title` (#1180), and `mcp-openapi.json` stamps it as `x-mcp-title` and `x-mcp-hints.title`
beside the operation's own `summary`. The decorator's former title argument is gone; passing one is a
compile error. `readOnlyHint`, `destructiveHint` and
`idempotentHint` are computed from the endpoint's declared `operation`; `openWorldHint` comes from
`{ openWorld: true }` on the endpoint.

The catalog carries the same descriptions the OpenAPI documents do (#1292): the method's `@returns`
is `outputSchema.description`, the request DTO's JSDoc is `inputSchema.description`, every field's
JSDoc is its property's `description`, and no `@privateRemarks` text reaches any of it.

Alongside `mcp-openapi.json`, a run writes ONE **`mcp-<ContractClass>-tools.json`** per contract that
declares `MCP` and has at least one `@WpMcpTool` (e.g. `mcp-PartnerOrdersApi-tools.json`). Those are
not documents: they are the RUNTIME catalogs `WpMcpServer` boots from, so the schema an agent is shown
in `tools/list` and the schema the server validates a call against are the same bytes. One file per
contract because a server binds contracts, and checks each binding against exactly its own contract's
file. `--format` does not apply to them.

## Descriptions: every `/** */` is published, `@privateRemarks` never is (#1292)

`//` and `/* */` comments are private; every `/** */` block is published, one JSDoc to one place:

| JSDoc on | Published as |
|---|---|
| a method | `operation.description` (and the MCP tool's `description`, unless an `@mcp` tag overrides it) |
| its `@summary` tag | `operation.summary` — the docs page heading and sidebar label — and the MCP tool's `title` and `annotations.title` (#1296) |
| its `@returns` tag | the success response's `description`, and the MCP catalog's `outputSchema.description` |
| a DTO class / interface / enum / union alias | `components.schemas.<Name>.description` — or, for a single-use request/response wrapper, the inline body schema's `description` beside its `title` (#1303) — (and the MCP catalog's `inputSchema.description` for the request DTO) |
| a field | the property's `description` |
| the contract class that OWNS a tag | `tags[<tag>].description` |

The rules hold for EVERY output — the OpenAPI documents, their bundled siblings, `mcp-openapi.json`
and the `mcp-<Contract>-tools.json` catalogs — and each refusal names every offender in one run and
writes nothing. None has an off switch.

- **`@privateRemarks` is dropped** with its text, everywhere. Write internal notes there.
- **`{@link X}` publishes X's PUBLISHED identity** as a markdown code span (#1284), in every output:

  | JSDoc link | Published as (a markdown code span) |
  |---|---|
  | `{@link MenuDto}` | `` `Menu` `` — the type's published schema name, after `schemaNames` stripping (a bundled document's qualified name where it has one; an inlined single-use wrapper's `title`, #1303) |
  | `{@link MenuDto.items}`, `{@link Gender.F}` | `` `Menu.items` ``, `` `Gender.F` `` — the `.member` tail kept as written |
  | `{@link OrdersApi.fetchOrders}` | `` `fetchOrders` `` — its operationId in the manifest's `operationIds` style, never `OrdersApi.`; in an `mcp-<Contract>-tools.json` catalog, a method that IS a tool publishes its tool `name` |
  | `{@link OrdersApi.fetchOrders \| the order list}` / `{@link X label}` | `the order list (`` `fetchOrders` ``)` — the label, then the identity |
  | `{@link https://…}` / `{@link https://… \| label}` | `<https://…>` / `[label](https://…)` — an ordinary markdown link |

  A link the compiler cannot resolve, one to something that is not a type or an `@Endpoint` method of
  an `@ApiPath` contract, and one to a type or operation the document does not publish are refused,
  naming every `file:line` in one run. `@webpieces/docs-site` links each such code span to its page.
- **`@summary` is REQUIRED** on every published operation, route and webhook alike (#1296): one line,
  at most 100 characters. It is the endpoint's short title — the OpenAPI `summary` (which used to be
  the bare method name) and the MCP tool's `title` / `annotations.title` — and the tag and its text are
  NOT part of `description`, which is the rest of the JSDoc body. A missing, multi-line or over-long
  summary is refused, naming every method and file in one run. The code identifier stays published
  as `operationId`.
- **`@returns` is REQUIRED** on every published method whose response has a body. It replaces the
  hard-coded `"Success."` the success response used to carry. A `Promise<void>` method needs none and
  keeps the derived acknowledgement sentence. Error responses keep the manifest's descriptions.
  Only `@returns` is read — JSDoc's older `@return` spelling is not.
- **Every published schema needs a description** — a class, interface, enum or union alias with no
  JSDoc is refused, naming the type and its `file:line`. A type declared under `node_modules` is that
  package's to own and is not judged.
- **A tag's description comes from the ONE non-webhook contract carrying it**, never from a webhook
  contract filed under the same tag. Two non-webhook contracts on one tag is refused, naming both; a
  tag carried only by webhook contracts takes the first one's JSDoc, in manifest order.

TypeScript starts a block tag at any `@word` preceded by whitespace, even mid-sentence, so write
"the returns tag" in prose rather than `@returns` — the latter ends the sentence and starts a tag.

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
