# BUG: api-scanner silently drops a service when its api-lib has no `tsconfig.base` paths entry (0.4.392)

> **STATUS: FIXED** (branch `dean/fix-api-scanner-dts-resolution`) — root cause confirmed exactly as
> analyzed below. All three suggested fixes implemented; acceptance check below passes against the
> real `monorepo-nx2`. Ships to consumers on the next tooling publish + version bump; until then the
> `tsconfig.base` paths workaround in `monorepo-nx2` is harmless and can stay.
>
> - **Fix #1 (no longer depends on `paths`)** — contracts are now indexed from workspace SOURCE in a
>   parser-only pre-pass (`ApiSourceIndexBuilder`) before any call site is resolved. When the checker
>   lands on a decorator-erased `dist/**.d.ts`, `ApiUsageScanner.recoverFromDeclaration` recovers the
>   contract from that index. `paths` is now a preference, not a precondition.
> - **Fix #2 (never fail silently)** — an abstract class in a declaration file that no workspace
>   source owns is now reported as `ApiScanResult.unresolvedApiCalls` and printed loudly by
>   `architecture:generate` (`describeUnresolvedApiCalls`). Deliberately a WARNING, not a hard
>   failure: a genuinely external (published, non-workspace) api-lib legitimately has no source
>   locally, and failing there would break real consumers.
> - **Fix #3 (message)** — `describeUnclassifiedApiDep` now diagnoses the erased-decorator config gap
>   and names the call site, instead of telling devs to add wiring they already have or to delete a
>   load-bearing dependency.
>
> **Acceptance result** (paths entries removed from `monorepo-nx2/tsconfig.base.json`, scanner run
> over the real repo — its `tsconfig.base.json` was restored afterwards, repo left clean):
>
> | scanner | `reports-dispatcher` |
> |---|---|
> | published 0.4.392 | **MISSING** — relations for `ai-chat`, `pg-dataaccess` only |
> | fixed | **present** — `implements`+`uses` `ReportsDispatcherApi` (pubsub), `uses` `ReporterTriggerApi` |
>
> Regression coverage: `src/lib/__tests__/api-scanner-no-paths.spec.ts` builds a throwaway workspace
> whose api-lib is consumed via a node_modules symlink with no paths entry (the bug cannot be
> reproduced from an in-memory AST — it lives in the module-resolution layer), plus the
> message-regression tests in `api-relations-validator.spec.ts`.

**Package:** `@webpieces/nx-webpieces-rules`
**Version seen:** `0.4.392` (bug confirmed present in ts50 `HEAD` source, not just the published build)
**Severity:** High — **silent incorrect output**. `architecture:generate` exits 0, prints a healthy
summary, and writes a `dependencies.json` / `runtime-dependencies.json` that is **missing whole
services**. Nothing warns. The graph looks complete and is not. A wrong-but-green architecture graph
is worse than a failing one: it is committed, rendered, and trusted.

## Symptom

A fully-wired webpieces service — real `router.addRoutes(XxxApi, XxxController)`, real
`@ApiPath`/`@PubSub`/`@AuthOidc` contract, real `@webpieces/cloudtasks-client` usage — gets **no
`apiRelations` block** in `dependencies.json` and is **absent from `runtime-dependencies.json`
entirely**. Sibling services in the same repo, wired identically, appear fine.

## Where to reproduce (consuming monorepo)

Full path: **`/Users/deanhiller/workspace/onetablet/monorepo-nx2`** (an AI can read it directly).

Before the fix, `pnpm nx run architecture:generate` printed `Runtime graph saved (2 services, 1
runtime edges)` — `ai-chat` and `pg-dataaccess` only. `reports-dispatcher` was missing despite:
- `services/reports-dispatcher/src/routes/ReportsDispatcherRoutes.ts:15` → `router.addRoutes(ReportsDispatcherApi, ReportsDispatcherController)`
- `libraries/apis/reports-dispatcher-api/src/apis/reports-dispatcher-api.ts:35-38` → `@PubSub() @AuthOidc() @ApiPath('/reports-dispatcher') export abstract class ReportsDispatcherApi`

Adding **only** two `tsconfig.base.json` paths entries (no source change) → `Runtime graph saved (3
services, 1 runtime edges)` and a correct `apiRelations` block appears. That one-line-per-lib config
delta is the entire difference between "service exists in the graph" and "service does not exist".

## Root cause: the scan resolves api contracts to the **built `.d.ts`**, where decorators are erased

The signal the scanner keys on (`@ApiPath`) **cannot survive** the resolution path it actually takes.

`api-scanner.ts:225`:
```ts
private apiClassInfoFor(cls: ts.ClassDeclaration): ApiClassInfo | null {
    if (!isAbstractClass(cls) || !hasClassDecorator(cls, 'ApiPath') || !cls.name) return null;
    const owner = this.locator.projectOf(cls.getSourceFile().fileName);
    if (owner === null) return null;
    ...
}
```

When the consuming repo has **no `tsconfig.base` paths entry** for the api-lib, TypeScript resolves
`import { ReportsDispatcherApi } from '@mealco-internal/reports-dispatcher-api'` through the
node_modules symlink → that package's `package.json` `"types": "dist/index.d.ts"`. So
`resolveClassDeclaration()` (`api-scanner.ts:219`) hands `apiClassInfoFor` the **declaration**, not
the source:

| `src/apis/reports-dispatcher-api.ts` (what the IDE shows) | `dist/apis/reports-dispatcher-api.d.ts` (what the checker resolves to) |
|---|---|
| `@PubSub()`<br>`@AuthOidc()`<br>`@ApiPath('/reports-dispatcher')`<br>`export abstract class ReportsDispatcherApi {`<br>`  @Endpoint('/run-period')`<br>`  runPeriod(...)` | `export declare abstract class ReportsDispatcherApi {`<br>`    runPeriod(_req: RunPeriodRequest): Promise<void>;`<br>`    fireReport(_req: FireReportRequest): Promise<void>;`<br>`}` |

**`tsc` erases decorators when emitting declarations** — they are runtime metadata, not part of the
type surface. This is correct, intended TypeScript behavior and will never change.

So `apiClassInfoFor` fails **twice over**, and both failures are silent `return null`:
1. `hasClassDecorator(cls, 'ApiPath')` → **false** (erased in the `.d.ts`).
2. `projectOf(cls.getSourceFile().fileName)` → **null** anyway (the `.d.ts` lives under
   `node_modules/…`/`dist/`, which matches no project root in `ProjectLocator`).

The `isDeclarationFile` skip at `api-scanner.ts:168` guards only the **outer file loop** (which files
we walk). It does **not** guard **resolution targets** — which is where the decorator is needed.

### The reliance on `paths` is known but unenforced

`api-scanner.ts:255-259`, on `createScanProgram`:
> *"…we fall back to globbing the project's own `src/**` and reuse the resolved compiler options
> (**which carry tsconfig.base `paths` for cross-package `@webpieces` resolution**)."*

The scanner therefore has a **hard, undocumented precondition**: every api-lib must have a
`tsconfig.base` paths entry pointing at its **source**. That precondition is never validated, never
documented as a requirement, and fails **silently** when unmet. It works in the webpieces repo
itself, and in any consuming repo that happens to path-map every lib — which is exactly why it
survives testing.

## Sub-bug: `validate-api-relations` fires correctly but **misdiagnoses**, sending devs chasing ghosts

With `validateApiRelations: true`, the validator *does* catch the missing relation. But its advice is
actively wrong:

```
❌ 'reports-dispatcher' (role:server) depends on api-lib '@mealco-internal/reports-dispatcher-api'
   but neither IMPLEMENTS nor USES any of its APIs (ReportsDispatcherApi).
   Do ONE of:
     2. IMPLEMENT it: add a controller and register it — apiFactory.addRoutes(ReportsDispatcherApi, TheController).
     3. If the dependency is unused, remove '@mealco-internal/reports-dispatcher-api' from 'reports-dispatcher'.
```

The service **already does** `addRoutes(ReportsDispatcherApi, ReportsDispatcherController)`, and the
dependency is **not** unused. Every suggestion is a dead end; option 3 actively invites deleting a
correct, load-bearing dependency. A developer following this message will not find the cause — it is
a config gap in `tsconfig.base.json`, which the message never mentions.

This misdiagnosis has a documented cost in the consuming repo. `monorepo-nx2` commit `a5ccc0f`
(2026-07-13) turned **both** validators off precisely because they produced "unexplained edges" that
looked like false positives:

> *"Tagging the 4 real contract libs `role:api-lib` therefore makes validate-api-relations fail with
> 'unexplained edges'. Until those services migrate onto webpieces http-client/cloudtasks, both new
> validators are turned off in nx.json (validateApiRelations, validateApiLibTag)."*
>
> *"Consequence of the bump: the committed runtime graph goes 8 services → 0."*

Some of that was the genuine wrapper issue named in the commit — but the misleading message gave no
way to tell "you haven't migrated yet" apart from "your paths entry is missing", so the whole guard
was disabled and the runtime graph silently rotted at 0 for a month.

## Suggested fix

1. **Do not depend on `tsconfig.base` paths (preferred).** The scanner already holds `projectInfos`
   — every workspace project's `name` and `root`. When `resolveClassDeclaration` lands on a
   declaration file or a `node_modules`/`dist` path, map the resolved package back to its **owning
   workspace project** (match the import's package name against each project's `package.json`
   `"name"`), then locate the class in that project's `src/**` and read the decorators from source.
   This makes the scan correct regardless of consumer tsconfig layout.
2. **Never fail silently.** If `resolveClassDeclaration` resolves an `addRoutes`/`createRpcClient`
   /`createPubSubClient` first argument to an `abstract class` that carries **no** `@ApiPath` **and**
   sits in a declaration file, that is unambiguously this bug — not a non-API argument. Emit a
   loud warning (or fail `generate`) naming the file and the missing paths entry. Today both
   conditions collapse into the same `return null` as "this expression isn't an API".
3. **Fix the `validate-api-relations` message.** When an `addRoutes(X)` / `createRpcClient(X)` call
   site for the api-lib exists **textually** but `X` never resolved to a decorated source class, say
   so:
   > `ReportsDispatcherApi resolved to dist/apis/reports-dispatcher-api.d.ts (decorators erased). Add a tsconfig.base paths entry → libraries/apis/reports-dispatcher-api/src/index.ts`

   Do not tell the user to add wiring that is already present, and do not suggest removing a
   dependency that is genuinely used.

### Files

- `packages/tooling/nx-webpieces-rules/src/lib/api-usage/api-scanner.ts:224-231` — `apiClassInfoFor`; the two silent `return null`s (decorator gate + `projectOf` gate).
- `packages/tooling/nx-webpieces-rules/src/lib/api-usage/api-scanner.ts:218-221` — `apiInfoFromExpr` / `resolveClassDeclaration`: the resolution that lands on the `.d.ts`.
- `packages/tooling/nx-webpieces-rules/src/lib/api-usage/api-scanner.ts:168` — `isDeclarationFile` skip; guards the file loop only, not resolution targets.
- `packages/tooling/nx-webpieces-rules/src/lib/api-usage/api-scanner.ts:255-271` — `createScanProgram`; the comment acknowledging the `paths` reliance.
- `packages/tooling/nx-webpieces-rules/src/lib/api-usage/api-relations-validator.ts` — `describeUnclassifiedApiDep`, the misleading message.

## Acceptance check

In `/Users/deanhiller/workspace/onetablet/monorepo-nx2`: **remove** the
`@mealco-internal/reports-dispatcher-api` and `@mealco-internal/reporter-trigger-api` entries from
`tsconfig.base.json` `paths`, then run `pnpm nx run architecture:generate`. It must **still** report
`3 services` and emit `reports-dispatcher`'s `apiRelations` — i.e. the graph is correct with no
paths entry at all. Failing that (if fix #1 is deferred), `generate` must at minimum **fail loudly**
naming the unresolved contract, instead of exiting 0 with a service missing.

---

### Consuming-repo status (context)

`monorepo-nx2` is unblocked with the paths-entry workaround (`tsconfig.base.json` + regenerated
graphs; full `ci:local` green, `validate-api-relations` re-enabled and passing). That fix is
defensible there on its own terms — every other `@mealco-internal/*` lib already has a paths entry,
so these two api-libs were the outliers. But it is a **workaround for this bug**, not a fix: the
next api-lib added without a paths entry will vanish from the graph just as silently.
