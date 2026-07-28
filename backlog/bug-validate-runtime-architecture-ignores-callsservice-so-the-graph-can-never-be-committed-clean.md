# BUG: validate-runtime-architecture ignores callsService, so a repo that adopts it can never commit a clean graph (0.4.465)

> **STATUS (fixed):** root cause was NOT two derivation paths — `generate` and `validate` already call
> the SAME `deriveRuntimeGraphReport`. The gap was serialization: `enrichGraph` set `entry.callsService`
> in memory (so `generate`, deriving from the enriched graph, saw 6 edges), but `graph-loader.ts`
> `formatEntryLines` writes `dependencies.json` through an explicit FIELD WHITELIST that emitted
> `serviceName` and never `callsService` — so the committed `dependencies.json` dropped it, and
> `validate` (which loads that file and re-derives) fanned back out to 12. Fix: persist `callsService`
> (both the string and `{ apiClassName: serviceName }` map forms) in `formatEntryLines`, next to
> `serviceName`. The load path is `JSON.parse`, so it surfaces the field back automatically once
> written. Regression test in graph-loader.spec.ts asserts save→load survives both forms. Acceptance
> checks 1–2 now hold. (Check 3 — a structural single-entry-point guard — is already true for the
> derivation; the remaining sharp edge is the write whitelist, which any new GraphEntry field must be
> added to; left as-is rather than reworked here.)


**Package:** `@webpieces/nx-webpieces-rules`
**Version seen:** `0.4.465` (the release that ADDED `callsService`, #479)
**Severity:** High — **adopting the feature breaks the build, permanently.** `generate` and
`validate-runtime-architecture` derive DIFFERENT graphs from the same inputs, so the validator always
reports "Runtime graph changed since last commit" no matter how many times you regenerate and commit.
There is no way out except removing the `callsService` declarations, i.e. un-adopting #479.

## Symptom

Declare the new field on a client project:

```json
// services/angular/helper-portal-angular/project.json
"metadata": { "webpieces": { "callsService": "helper-portal" } }
```

`nx run architecture:generate` honours it — the fan-out collapses from 12 edges to 6, and the warning
count drops from 7 to 1:

```
✅ Runtime graph saved (7 services, 6 runtime edges)
⚠️  1 runtime edge(s) could not be targeted to ONE service:      <-- only agent-listener remains
```

Commit that result, then run the validator on the SAME tree:

```
⚠️  7 runtime edge(s) could not be targeted to ONE service:      <-- the pre-callsService list is back
     • helper-portal-angular uses "AuthApi" ...
     • helper-portal-angular uses "BrowserLogApi" ...
     • helper-portal-angular uses "WarmupApi" ...
     • lang-angular uses ... (etc)
❌ Runtime architecture validation failed:
  - Runtime graph changed since last commit — run: nx run architecture:generate and commit the result
```

The committed file has **6** edges (verified: `git show HEAD:architecture/runtime-dependencies.json`).
The validator re-derives **12**. So its "changed since last commit" is comparing its own stale
derivation against a correct committed file, and the instruction it prints — regenerate and commit —
is exactly what was already done. The loop never terminates.

Ruled out: it is not an nx cache artifact. `pnpm nx reset` then re-running gives the identical 7
warnings and the same failure.

## Root cause (suspected): two derivation paths, only one reads project metadata

`generate` reads `metadata.webpieces.callsService` off `project.json` when resolving a `uses` target.
The validate executor derives the runtime graph through its own path, which appears not to consult
project metadata at all — the same failure mode already recorded in
`backlog/bug-runtime-architecture-generate-vs-validate-divergence.md`. This is a second instance of
that class: any resolution input read by only one of the two paths makes the graphs disagree, and the
disagreement surfaces as an unfixable "graph changed".

The durable fix is not "teach validate about `callsService`" — it is to have BOTH executors call ONE
derivation function, so a future resolution input cannot diverge again. Teaching validate about this
one field fixes today's symptom and leaves the mechanism intact.

### Files

- the `generate` executor's runtime-graph derivation — where `callsService` is read (#479)
- `packages/tooling/nx-webpieces-rules/src/executors/validate-runtime-architecture/executor.ts` — the second derivation path
- `packages/tooling/nx-webpieces-rules/src/lib/runtime-graph.ts` — `deriveRuntimeGraph` / `buildEdges`, the shared code both SHOULD be going through

## Acceptance check

1. A repo that declares `callsService`, runs `architecture:generate`, and commits the result passes
   `validate-runtime-architecture` with no changes reported.
2. `generate` and `validate` report the SAME warning count and the SAME edge set for any tree.
3. Ideally, enforced structurally: one derivation entry point, with the validator consuming exactly
   what the generator produces — so the next resolution input added cannot reintroduce this.

---

### Consuming-repo status (context)

`ctoteachings/monorepo3` is on 0.4.465 with `callsService` declared on both websites. The graph is
CORRECT — `helper-portal-angular -> helper-svr` and `lang-angular -> lang-server`, the four fictional
edges gone — but CI cannot pass, so the change is blocked on this fix. Removing the declarations makes
CI green again and restores the fiction, which is the choice this bug forces.
