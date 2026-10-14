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

The enforced matrix lives in `.webpieces-config/rules/nx-webpieces-rules.json` under
`product-tags.productDependencies`. A product always permits dependencies on
itself. An omitted entry permits no outward product dependencies.

Run `pnpm nx run architecture:generate` after changing ownership or dependencies.
Run `npm run arch:visualize` to open the saved graph; its Product color mode and
legend show ownership, cross-product edges, and the allowed dependency matrix.

## Stable graph colors

Product colors come from one fixed palette of eight saturated colors (blue,
orange, red, teal, green, yellow, purple, pink), each with the text color that
reads on it. A product's preferred color is chosen by its name: the first byte of
SHA-256(`<name>`), mod 8. When two products prefer the same color, products are
taken in sorted-name order: the first keeps it and the later one takes the next
free color (wrapping). So adding a product changes no existing color unless the
new name hashes onto a color already taken AND sorts before the product holding
it. Products are never colored by their position in the sorted list: that would
recolor every later product whenever one is added. Past eight products, the extra
products share their preferred color; none falls back to the neutral fill.

Because collisions are resolved over the whole set, both viewers build the
palette over every declared product, even when the runtime graph shows only a
subset or hides a service. Nodes, crossing edges, legends, and filter swatches
all read that one palette. Renaming a product can change its color.

Colors are automatic; consumers do not need to configure them. Neutral means a
box belongs to every declared product; white/dashed means no product.

Runtime framework colors, Architecture role colors, and Impact status colors are
fixed semantic palettes. A box changes those colors only when its framework, role,
or impact status changes. Runtime context shapes retain their fixed kind colors.
