# Responsibilities — nx-webpieces-rules

Nx inference plugin that auto-wires webpieces build gates with no manual project.json edits: architecture and runtime graph generators/validators, the Inversify DI design.json/design.md generator, a per-project circular-import gate, and many validate-* code-style and size executors.

## In Scope

- The `createNodesV2` inference plugin (`src/plugin.ts`) that attaches webpieces validation/generation targets to every project automatically.
- Architecture graph tooling in `src/lib`: generator, sorter, comparator, loader, visualizer, metadata, framework-resolver, project-info, transitive-reduction, and `responsibilities.md` ingestion.
- PRODUCTS on both graphs (#1179): `product-resolver.ts` reads the `product:<name>` nx tags, `graph-products.ts` derives each project's (and each runtime service's) `products` membership and the Product color palette, and both pages filter by product; `graph-entry-levels.ts` pins every server, client and app to the top row of the dependency graph.
- API architecture metadata that records each endpoint's resolved HTTP method, path/query/body parameter mapping, and body-vs-full response ownership so generated design output reflects its real wire contract. The full contract is written to one `architecture/apis/<ApiName>.json` per API, which `dependencies.json` only links to.
- The API CONTRACT SHAPE rules the workspace-wide `@ApiPath` scan enforces, `no-root-union-api-type` first among them (`src/lib/api-usage/root-union-scan.ts`): a request or response type that IS a union fails the build, because both the OpenAI and the Anthropic function-calling APIs reject a top-level `oneOf` and one such tool 400s every request in an MCP session. It runs on EVERY `@ApiPath` contract, `@ApiType` or not — which is why it lives here and not in `@webpieces/api-doc-model`, whose parser only ever visits contracts that have opted in.
- TAG TRUTH (#1064): the framework lattice gives `react-native` its own up-set (not a browser), the
  `react-native` dependency marker wins over `react`, and the role set gains `api-client` (a contract plus
  its SDK adapter) beside `api-lib` (a contract and/or its DTOs). `tag-truth.ts` runs four graph rules
  after enrichGraph in `architecture:generate` and `validate-architecture-unchanged` —
  `api-lib-dependencies`, `api-lib-path`, `framework-folder`, `product-tags` (#1179: every listed role
  carries a `product:<name>` tag) — and `validate-api-lib-tag` accepts a DTO-only,
  IPC or in-process contract library (including data-only protocol constants), recognizes an exported
  `…Api` interface implemented by its registered default api-client, and refuses executable implementation
  exports from `role:api-lib`. Inside the `api-rules-for-openapi` / `api-rules-for-mcp` scan, the
  WIRE CLOSURE (`wire-closure.ts`) requires every type a contract reaches to be declared in a
  `role:api-lib` project and to carry its `required-type-suffix` suffix; `generate:openapi-components` is
  refused on anything but a `role:api-lib` (`ComponentsWiring` and the executor). See
  `.claude/rules/framework-tags.md`.
- Runtime microservice graph tooling: `runtime-graph`, `runtime-cycles`, `runtime-markers`, `runtime-visualizer`, `runtime-config`.
- The Inversify DI graph (`src/lib/di-graph`) that emits per-project `design.json` + `design.md`.
- All `src/executors/*` implementations declared in `executors.json`: `generate`/`visualize`, `di-graph-generate`, `openapi-generate`/`openapi-components-generate`/`docs-generate` (INFERRED by the plugin on a project tagged `generate:openapi` / `generate:openapi-components` (a DTO library's `components.openapi.json`, #1058) / `generate:docs-site`; the API documents and one MCP tool catalog per contract go into the outputPath of the `build` (tsc) target `openapi-generate` dependsOn so they ship inside the package, the docs site into a gitignored `<projectRoot>/<siteDir>` for hosting; never committed; they run the CONSUMER's generator, never a bundled copy — `ConsumerBinResolver` + version handshake in `src/lib/api-docs`; `validate-nx-wiring` enforces, on the resolved graph, `openapi-generate` dependsOn exactly `["build"]` and `^openapi-generate` in the effective `build`/`test` dependsOn of every transitive dependent, naming the nx.json targetDefaults key and line to edit, plus `^openapi-components-generate` on every generating target that reaches a components-publishing library (`ComponentsWiring`); see `.claude/rules/api-docs.md`), and the `validate-*` gates (architecture, cycles, file-import cycles via bundled madge, method/file size, return types, no-any, packagejson, versions-locked, eslint-sync, nx-wiring, DTO/prisma, etc.).

## Out of Scope

- Toolchain installation, OpenClaw composition, and aggregate package tests — owned by webpieces-tooling.

- The raw ESLint rule logic itself — defined in `eslint-rules`; here it is only invoked/wrapped as executors.
- PR-gate workflow CLIs (`wp-*-upsert-pr`, merge dashboard) — those live in `pr-gate`.
- Generic config loading and validation (rules-config); pure field and shared scope contracts (rules-sdk).
- Product/runtime framework code (http, routing, DI container) — this is build-time Nx tooling only.

## Notes (optional)

Gates are wired into the build via `nx.json` `targetDefaults.dependsOn` (e.g. `validate-no-file-import-cycles` before `@nx/js:tsc`), so `nx affected`/`run-many` run them. `madge` is a pinned dependency to avoid runtime `npx` fetches. On/off + dated grace windows come from `webpieces.config.json`.

Nx-native policy schemas, concrete mode enums, optional tuning, reviewed seeds, and native field retirements belong here. Source and Code contributions refer to canonical owners without copying their schemas.
