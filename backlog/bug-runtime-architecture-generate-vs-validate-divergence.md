# BUG: `validate-runtime-architecture` can never match `generate` output (0.3.346)

**Package:** `@webpieces/nx-webpieces-rules`
**Version seen:** `0.3.346` (regression — `0.3.340` was fine)
**Severity:** High — `architecture:validate-runtime-architecture` **always fails** after a fresh
`architecture:generate`, on a clean, freshly-generated, committed tree. It blocks the build/CI gate
for every consuming repo that uses the runtime graph. There is **no repo-side fix** — both sides of
the comparison live in this package.

## Where to reproduce (consuming monorepo)

Full path: **`/Users/deanhiller/workspace/ctoteachings/monorepo1`** (an AI can read it directly).
Relevant artifacts there:
- `architecture/runtime-dependencies.json` — the committed graph, written by `generate` (**class-name keyed**, edges/apis carry `"type": "rpc"`).
- `webpieces.config.json` → `rules.runtime-architecture` (`servicePaths: ["services/*"]`, `apiProjectPaths: [...8 api libs...]`).
- `services/*/service-contract.json` — the `implements`/`uses` markers (package names like `@myorg/auth-apis`).

Repro:
```
pnpm nx run architecture:generate            # writes runtime-dependencies.json, prints "7 services, 10 runtime edges"
git add -A && git commit ...                 # commit the fresh graph (tree now clean)
pnpm nx run architecture:validate-runtime-architecture   # ❌ "Runtime graph changed since last commit"
```
`git status` is clean and `generate` is deterministic (re-running produces no diff), yet validate
still reports "changed".

## Root cause: two different assemblers feed the unchanged-check

`executors/validate-runtime-architecture/executor.ts` → `checkUnchanged()` compares:
```ts
serializeRuntimeGraph(loadRuntimeGraph(root))   // "saved"   = what generate WROTE
=== serializeRuntimeGraph(current)              // "current" = re-assembled HERE, differently
```
…but `saved` and `current` are produced by **two different assemblers that key the graph differently**:

| | `generate` (writes `saved`) | `validate` (builds `current`) |
|---|---|---|
| Assembler | `assembleRuntimeGraphFromScan(scan)` → `ScanRuntimeAssembler` (`lib/runtime-graph.ts`) | `assembleRuntimeGraph(model)` → `collectServiceDecls(model)` (`lib/runtime-graph.ts`) |
| Source of truth | **source scan** (`lib/api-usage/api-scanner.ts`: `addRoutes(...)` / `createRpcClient(...)` call sites) | **service-contract.json markers** via `buildWorkspaceModel` (`lib/runtime-markers.ts`) |
| API key | **API class name** — `ApiRef.api` (e.g. `"AuthApi"`, `"AgentApi"`) | **api-lib project name** — `resolvePackageNames(model, pkgs).projects` (e.g. `"auth-apis"`, `"agent-apis"`) |
| Edge/api `type` field | present (`"type":"rpc"` from `@Rpc`/`@PubSub`) | **absent** (markers have no transport info) |
| Node set (services) | **any project** with an implements/uses relation, incl. `libraries/*` | only `info.isService` projects (i.e. `servicePaths`, `services/*`) |

Because the two graphs are keyed and shaped differently, `serializeRuntimeGraph(saved) ===
serializeRuntimeGraph(current)` is **structurally impossible** to satisfy.

### Evidence (first differing serialized line)

Assembling both in-process and diffing their `serializeRuntimeGraph` output:
```
MATCH: false
first diff line 6
  saved  : "                \"AgentApi\""      // class name  (generate / scan)
  current: "                \"agent-apis\""    // project name (validate / markers)
```
Every `implements`/`uses`/`apis`-key/edge-`via` entry differs the same way (class vs project name),
plus every edge/api in `saved` has a `"type"` field that `current` lacks.

## Two distinct sub-bugs

**Bug A — key + shape mismatch (the blocker).** `ScanRuntimeAssembler` keys by API **class name** and
stamps `type`; `collectServiceDecls` keys by api-lib **project name** and omits `type`. Same services,
incompatible serialization.

**Bug B — node-set (service-scoping) mismatch.** The scan treats *any* project that calls
`createRpcClient(...)` / `addRoutes(...)` as a runtime node, including `libraries/*`. `collectServiceDecls`
filters to `info.isService` (only `servicePaths`). So a shared Angular lib that builds an API client
(e.g. `auth-angular`'s `provideSharedAuth` calling `createRpcClient(AuthApi, ...)`) appears as an
extra "service" in `generate` but not in `validate` → the service **count** also differs (8 vs 7).
`api-scanner.ts` records relations for every project in `projectInfos` with no `isService`/role filter.

> In `0.3.340` this all matched because **both** `generate` and `validate` used the marker-based
> assembler. `0.3.346` switched `generate` to `assembleRuntimeGraphFromScan` (good — richer, real
> `type`s, real call sites) but left `validate`'s unchanged-check on the marker-based assembler.

## Suggested fix

Make the unchanged-check compare like-for-like. Options, best first:

1. **Single assembler (preferred).** Have `validate-runtime-architecture` assemble `current` with the
   **same source scan** `generate` uses (`assembleRuntimeGraphFromScan` over `api-scanner` output),
   then compare. One source of truth; the marker-based `assembleRuntimeGraph` stays only for
   `validate-runtime-markers` (the per-service compile-deps == implements∪uses check, which is fine).
   - This also settles Bug B automatically: decide once, in the scanner/assembler, whether a
     `libraries/*` project that only *builds a client* is a node. Recommended: **exclude non-`isService`
     projects** (or attribute the client call to the consuming service), so a shared client-factory
     lib doesn't masquerade as a service.
2. If you want to keep validate marker-based, then the scan and marker assemblers must be reconciled:
   resolve class-name ↔ project-name consistently in both, include/exclude `type` in both, and apply
   the same `isService` node filter in both. (More surface area; easy to drift again.)

### Files

- `packages/tooling/nx-webpieces-rules/src/executors/validate-runtime-architecture/executor.ts` — `checkUnchanged()` / which assembler builds `current`.
- `packages/tooling/nx-webpieces-rules/src/lib/runtime-graph.ts` — `ScanRuntimeAssembler` (class-keyed, `type`) vs `assembleRuntimeGraph`/`collectServiceDecls` (project-keyed, no `type`); `serializeRuntimeGraph`.
- `packages/tooling/nx-webpieces-rules/src/lib/api-usage/api-scanner.ts` — records relations for every project (no `isService`/role filter → Bug B).
- `packages/tooling/nx-webpieces-rules/src/executors/generate/executor.ts` — calls `assembleRuntimeGraphFromScan`.
- `packages/tooling/nx-webpieces-rules/src/lib/runtime-markers.ts` — `buildWorkspaceModel`, `resolvePackageNames`, `isService`.

## Acceptance check

In `/Users/deanhiller/workspace/ctoteachings/monorepo1`: after `architecture:generate` + commit,
`architecture:validate-runtime-architecture` passes on a clean tree, and passes again with no changes
on a second run.

---

### Side note (already worked around in the consuming repo, mention for context)

To dodge Bug B, the consuming repo moved the `createRpcClient(AuthApi, ...)` binding out of
`auth-angular`'s `provideSharedAuth` into each app's `app.config.ts` (so the scan attributes the RPC
to the app service, not the shared lib). That fixed the 8→7 service count but **not** Bug A. The repo
intends to move that binding back into the shared lib once this is fixed — so the real fix should make
a `libraries/*` client-factory not appear as a service on its own (Bug B), independent of where the
`createRpcClient` call textually lives.
