# Responsibilities — nx-webpieces-rules

Nx inference plugin that auto-wires webpieces build gates with no manual project.json edits: architecture and runtime graph generators/validators, the Inversify DI design.json/design.md generator, a per-project circular-import gate, and many validate-* code-style and size executors.

## In Scope

- The `createNodesV2` inference plugin (`src/plugin.ts`) that attaches webpieces validation/generation targets to every project automatically.
- Architecture graph tooling in `src/lib`: generator, sorter, comparator, loader, visualizer, metadata, framework-resolver, project-info, transitive-reduction, and `responsibilities.md` ingestion.
- API architecture metadata that records each endpoint's resolved HTTP method, path/query/body parameter mapping, and body-vs-full response ownership so generated design output reflects its real wire contract. The full contract is written to one `architecture/apis/<ApiName>.json` per API, which `dependencies.json` only links to.
- The API CONTRACT SHAPE rules the workspace-wide `@ApiPath` scan enforces, `no-root-union-api-type` first among them (`src/lib/api-usage/root-union-scan.ts`): a request or response type that IS a union fails the build, because both the OpenAI and the Anthropic function-calling APIs reject a top-level `oneOf` and one such tool 400s every request in an MCP session. It runs on EVERY `@ApiPath` contract, `@ApiType` or not — which is why it lives here and not in `@webpieces/api-doc-model`, whose parser only ever visits contracts that have opted in.
- Runtime microservice graph tooling: `runtime-graph`, `runtime-cycles`, `runtime-markers`, `runtime-visualizer`, `runtime-config`.
- The Inversify DI graph (`src/lib/di-graph`) that emits per-project `design.json` + `design.md`.
- All `src/executors/*` implementations declared in `executors.json`: `generate`/`visualize`, `di-graph-generate`, `openapi-generate`/`docs-generate` (INFERRED by the plugin on a project tagged `generate:openapi` / `generate:docs-site`; the API documents and one MCP tool catalog per contract go into the outputPath of the compile target `openapi-generate` dependsOn so they ship inside the package, the docs site into a gitignored `<projectRoot>/<siteDir>` for hosting; never committed; they run the CONSUMER's generator, never a bundled copy — `ConsumerBinResolver` + version handshake in `src/lib/api-docs`; `validate-nx-wiring` enforces the `compile` → `openapi-generate` → `build` (nx:noop) shape and `test` dependsOn `^build` on every dependent; see `.claude/rules/api-docs.md`), and the `validate-*` gates (architecture, cycles, file-import cycles via bundled madge, method/file size, return types, no-any, packagejson, versions-locked, eslint-sync, nx-wiring, DTO/prisma, etc.).

## Out of Scope

- The raw ESLint rule logic itself — defined in `eslint-rules`; here it is only invoked/wrapped as executors.
- PR-gate workflow CLIs (`wp-*-upsert-pr`, merge dashboard) — those live in `pr-gate`.
- Rule enable/disable config schema — owned by `@webpieces/rules-config`; this plugin reads `webpieces.config.json`, it does not define the token vocabulary.
- Product/runtime framework code (http, routing, DI container) — this is build-time Nx tooling only.

## Notes (optional)

Gates are wired into the build via `nx.json` `targetDefaults.dependsOn` (e.g. `validate-no-file-import-cycles` before `@nx/js:tsc`), so `nx affected`/`run-many` run them. `madge` is a pinned dependency to avoid runtime `npx` fetches. On/off + dated grace windows come from `webpieces.config.json`.
