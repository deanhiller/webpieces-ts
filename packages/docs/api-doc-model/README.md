# @webpieces/api-doc-model

Read a webpieces API contract with the TypeScript compiler API and produce one in-memory `ApiDocModel`.

No runtime behaviour and no file output. This is the single extraction pass that OpenAPI documents and MCP tool lists are both rendered from, so the two can never disagree about what the contract says.

It carries ONE renderer of its own, `McpSchemaRenderer`, because the MCP projection is not a document — it is `@webpieces/core-util`'s own `ApiJsonSchema`, which an MCP server publishes verbatim in `tools/list` and validates calls against. It is the SOLE source of that schema: #983 measured it against the reflect-metadata runtime that used to build one at boot, found them identical for every shape that runtime could build, and #984 deleted the runtime half. The OpenAPI document, which genuinely is a document, is `@webpieces/openapi-generator`'s job.

```typescript
import { ApiDocExtractor } from '@webpieces/api-doc-model';

const model = new ApiDocExtractor().extractFile('/abs/path/to/SaveApi.ts', {
    experimentalDecorators: true,
});

model.contractName; // 'SaveApi'
model.basePath; // '/api/save'
model.endpoints; // DocumentedEndpoint[]
model.types; // ReadonlyMap<string, DocumentedType> — a renderer's $ref targets
model.unmapped; // UnmappedType[] — recorded, never dropped
```

It depends on `typescript` and `@webpieces/core-util`, from which it takes every decorator NAME it matches on — so renaming a decorator is a compile error here rather than a literal that quietly stops matching and empties a generated document. See `responsibilities.md` for what is in and out of scope, why that import is not the coupling it looks like, and why both `Integer` and `@WpInt()` are accepted spellings of integer-ness.

```typescript
import { ApiDocExtractor, McpSchemaRenderer } from '@webpieces/api-doc-model';

// Every `@ApiPath` contract in one file — a repo does not obey one-contract-per-file.
const models = new ApiDocExtractor().extractAll('/abs/path/to/Fixtures.ts', options);

const tools = new McpSchemaRenderer(models[0]).render();
tools[0].name; // the stable protocol name from @WpMcpTool
tools[0].description; // the method's JSDoc body, or its `@mcp` tag
tools[0].hints; // three computed from `operation`, openWorldHint from @Endpoint's options
tools[0].inputSchema; // ApiJsonSchema — what tools/list publishes and the server validates against

// The whole build's tools, as `wp-openapi` writes them to mcp-tools.json.
McpSchemaRenderer.catalogOf(models).toJsonText();
```

An MCP header is declared in JSDoc as `@mcpHeader <token>`, which is now its only spelling: the runtime's `WpMcpHeader` argument said the same thing and #984 deleted it.
