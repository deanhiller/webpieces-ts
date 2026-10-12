# Product dependencies

Product tags identify ownership. Shared foundations have their own products so
consuming a foundation does not grant access to an entire runtime or renderer.

| Product | Owns | May depend on |
| --- | --- | --- |
| `core` | `core-util`: shared contract decorators, schemas, errors, and utilities | Itself |
| `api-model` | `api-doc-model`: contract extraction and shared documentation model | `core` |
| `platform` | Runtime clients, servers, dependency injection, queues, and logging | `core` |
| `openapi` | OpenAPI generation and the documentation site | `api-model`, `core` |
| `rules` | Development tooling and contract validators | `api-model`, `core` |
| `example` | Example applications and contracts | `platform`, `openapi`, `core` |

`api-doc-model` imports the real contract declarations from `core-util`, keeping
decorator renames visible to the compiler. Rules consume that shared model to
validate contracts. Neither dependency requires an allowance from OpenAPI to
platform or from rules to OpenAPI.

`core-util` belongs only to `core`; shared use does not give it several owners.
`api-doc-model` belongs only to `api-model`, which serves both documentation and
validation. The other products cannot depend on example code, and neither
foundation may depend back on its consumers.

The enforced matrix lives in `.webpieces/rules/nx-webpieces-rules.json` under
`product-tags.productDependencies`. A product always permits dependencies on
itself. An omitted entry permits no outward product dependencies.

Run `pnpm nx run architecture:generate` after changing ownership or dependencies.
Run `npm run arch:visualize` to open the saved graph; its Product color mode and
legend show ownership, cross-product edges, and the allowed dependency matrix.
