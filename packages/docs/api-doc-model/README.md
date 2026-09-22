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

It depends on `typescript` and `@webpieces/core-util`, from which it takes every decorator NAME it matches on — so renaming a decorator is a compile error here rather than a literal that quietly stops matching and empties a generated document. See `responsibilities.md` for what is in and out of scope, why that import is not the coupling it looks like, and why both `Integer` and `@WpInt()` are accepted spellings of integer-ness.
