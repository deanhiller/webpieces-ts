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

## Stable graph colors

Product colors are derived from the exact `product:<name>` name using SHA-256.
Adding, removing, or reordering other products does not change an existing
product's color. Architecture and runtime use the same assignment, even when
runtime shows only a subset. Nodes, crossing edges, legends, and filter swatches
use that assignment. Renaming a product changes its identity and therefore its
color. There is no eight-product limit or overflow into the shared neutral fill.

Colors are automatic; consumers do not need to configure them. Name-based colors
can be similar, so the product labels remain the ownership key. Neutral means a
box belongs to every product in that graph; white/dashed means no product.

Runtime framework colors, Architecture role colors, and Impact status colors are
fixed semantic palettes. A box changes those colors only when its framework, role,
or impact status changes. Runtime context shapes retain their fixed kind colors.
