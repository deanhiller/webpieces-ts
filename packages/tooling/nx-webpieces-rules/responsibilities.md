# Responsibilities — nx-webpieces-rules

Nx inference plugin that auto-wires webpieces build gates with no manual project.json edits: architecture and runtime graph generators/validators, the Inversify DI design.json/design.md generator, a per-project circular-import gate, and many validate-* code-style and size executors.

## In Scope

- The `createNodesV2` inference plugin (`src/plugin.ts`) that attaches webpieces validation/generation targets to every project automatically.
- Architecture graph tooling in `src/lib`: generator, sorter, comparator, loader, visualizer, metadata, framework-resolver, project-info, transitive-reduction, and `responsibilities.md` ingestion.
- Runtime microservice graph tooling: `runtime-graph`, `runtime-cycles`, `runtime-markers`, `runtime-visualizer`, `runtime-config`.
- The Inversify DI graph (`src/lib/di-graph`) that emits per-project `design.json` + `design.md`.
- All `src/executors/*` implementations declared in `executors.json`: `generate`/`visualize`, `di-graph-generate`, and the `validate-*` gates (architecture, cycles, file-import cycles via bundled madge, method/file size, return types, no-any, packagejson, versions-locked, eslint-sync, nx-wiring, DTO/prisma, etc.).

## Out of Scope

- The raw ESLint rule logic itself — defined in `eslint-rules`; here it is only invoked/wrapped as executors.
- PR-gate workflow CLIs (`wp-*-upsert-pr`, merge dashboard) — those live in `pr-gate`.
- Rule enable/disable config schema — owned by `@webpieces/rules-config`; this plugin reads `webpieces.config.json`, it does not define the token vocabulary.
- Product/runtime framework code (http, routing, DI container) — this is build-time Nx tooling only.

## Notes (optional)

Gates are wired into the build via `nx.json` `targetDefaults.dependsOn` (e.g. `validate-no-file-import-cycles` before `@nx/js:tsc`), so `nx affected`/`run-many` run them. `madge` is a pinned dependency to avoid runtime `npx` fetches. On/off + dated grace windows come from `webpieces.config.json`.
