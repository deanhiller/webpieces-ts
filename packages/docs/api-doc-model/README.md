# @webpieces/api-doc-model

Read a webpieces API contract with the TypeScript compiler API and produce one in-memory `ApiDocModel`.

No renderer, no runtime behaviour, no file output. This is the single extraction pass that OpenAPI documents and MCP tool lists are both rendered from, so the two can never disagree about what the contract says.

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

It depends on `typescript` and nothing else, so it can be pointed at any project's contract. See `responsibilities.md` for what is in and out of scope, why that dependency constraint is the product rather than tidiness, and why both `Integer` and `@WpInt()` are accepted spellings of integer-ness.
