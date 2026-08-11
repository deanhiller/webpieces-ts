# Guard layer toggles — `hookGuards` 9 keys → 3

> # ⚠️ SUPERSEDED — SHIPPED, AND NOT WITH THESE KEY NAMES
>
> The collapse described here **has landed**. Read `GUARD_MATRIX.md` and `guards/L2-branch-state.md` /
> `guards/L4-pr-lifecycle.md` for what actually exists; this file is kept only for the reasoning that led
> there, and everything below the fold is frozen as it was written.
>
> **The key names shipped SUFFIXED, not bare.** This plan proposed `branch-state` / `branch-cleanup` /
> `pr-lifecycle`; the shipped keys are **`branch-state-guard`**, **`branch-creation-guard`** and
> **`pr-lifecycle-guard`**. Three docs proposed three different spellings of the same three policies at
> once, which is precisely the drift that made the tables generated. Do not take a key name from this
> file.
>
> **`branch-creation-guard` was NOT renamed.** This plan's `branch-cleanup` rename is rejected: it is
> already one class implementing one policy and carrying real settings, so the rename would cost a
> retirement entry, a migration and prose churn across ~10 files for zero policy change.
>
> Two proposals in the later sections were also **killed** rather than deferred: a section-level
> `hookGuards.mode` kill switch (it is a second spelling of three `"mode": "OFF"` lines, and it fights
> the data model in five places — the loader flattens the section, the validator reports it as an unknown
> rule, and `ConfigPruner` then DELETES it, since the error banner recommends the very tool that eats
> it), and declaring the PR host to make an unfireable guard a load-time error (it can honestly
> disqualify exactly one of the old nine keys, and that key no longer exists; the real failure is `gh`
> present-but-unauthenticated at refresh time, which no load-time declaration can see — that one is
> closed by the `no-forge` `ALLOW_FAIL_OPEN` verdict instead).
>
> Written after the L0/L1 audit-trail work (#626), which at the time also covered a layer called L-1.
> **L-1 is deleted** (both guard hooks are registered absolute now, so nothing has to police `cd` to keep
> them launchable) and this file was corrected to match. The layer names here are the ones the log
> streams use, so the two vocabularies stay in step.

## Context

`webpieces.config.json` → `hookGuards` carries **nine keys, one per implementation CLASS**:

| key | layer | fields beyond the two escape hatches |
|---|---|---|
| `feature-branch-guard` | L2 | `mode`, `branchNamingConvention`, `hangTimeoutMinutes` |
| `read-stale-guard` | L2 | `mode`, `hangTimeoutMinutes` |
| `stale-main-bash-guard` | L2 | `mode`, `hangTimeoutMinutes` |
| `merged-branch-bash-guard` | L2 | `mode`, `hangTimeoutMinutes` |
| `branch-creation-guard` | L3 | `mode` (ON/OFF/ON_NO_SUBBRANCHES), `subBranchNaming`, `branchFormat`, `maxLocalBranches`, `maxWorktrees`, `autoReapMergedBranches` |
| `pr-creation-or-push-guard` | L4 | `mode`, `upsertPrCommand` |
| `merge-in-progress-guard` | L4 | `mode`, `mergeCompleteCommand` |
| `pr-merge-guard` | L4 | `mode` |
| `redirect-how-to-merge-main` | L4 | `mode` |

Schemas: `packages/tooling/rules-config/src/rule-configs.ts` (L3/L4) and
`main-sync-guard-configs.ts` (L2). Name list: `sections.ts` (`HOOK_GUARD_NAMES`).

**A class is an implementation detail; a layer is a policy.** `guards/L2-branch-state.md` names the
defect this creates: *half a policy is representable.* `read-stale-guard: OFF` beside
`merged-branch-bash-guard: ON` is exactly the "reading the file is allowed, `cat` of the same file is
blocked" split that doc calls the incoherence. The four L2 keys also carry **four copies of
`hangTimeoutMinutes`**, all tuning the ONE detached refresher behind `.webpieces/main-sync-status.json`.

Goal, stated twice by the requester: **simpler, and LESS configuration.** 9 → 3.

## The recommended key set

| key | layer | why |
|---|---|---|
| `branch-state` | L2 | one switch over the four cache-driven guards; makes the half-policy state unrepresentable |
| `branch-cleanup` | L3 | 1:1 rename of `branch-creation-guard` — already one class, one policy |
| `pr-lifecycle` | L4 | one gated flow (`wp-start-upsert-pr` → `wp-review-upsert-pr` → `wp-finish-upsert-pr`), one switch |

```json
"hookGuards": {
    "branch-state": {
        "mode": "ON",
        "branchNamingConvention": "{whoami}/{featurename}",
        "hangTimeoutMinutes": 5,
        "turnOffRuleUntilEpoch": 0,
        "turnOffRuleWhileOnBranch": null
    },
    "branch-cleanup": {
        "mode": "ON_NO_SUBBRANCHES",
        "subBranchNaming": "feature/<ticket>/<short-description>",
        "autoReapMergedBranches": true,
        "maxLocalBranches": 5,
        "maxWorktrees": 10,
        "turnOffRuleUntilEpoch": 0,
        "turnOffRuleWhileOnBranch": null
    },
    "pr-lifecycle": {
        "mode": "ON",
        "turnOffRuleUntilEpoch": 0,
        "turnOffRuleWhileOnBranch": null
    }
}
```

`branch-state` and `pr-lifecycle` take `ON_OFF_MODES`. `branch-cleanup` keeps `BRANCH_GUARD_MODES`
(`ON | OFF | ON_NO_SUBBRANCHES`) — that third value is a real policy choice, not an on/off.

**The nine CLASSES stay.** They carry the tool wiring and the per-guard identity that
`L2-decisions/` lines are grepped by (`GuardDecision.rule`). Only the SWITCH merges:
`BUILT_IN_RULE_MAP` (`ai-hook-rules/src/core/load-rules.ts`) constructs several classes from one
layer config.

## L0 and L1 get NO key — this is the load-bearing half

The audit trail covers **three** layers; the config covers **three** of its own, and the two missing
here are not an oversight. They have no key today and must not gain one.

| layer | proposed name | verdict | reasoning |
|---|---|---|---|
| **L0** | `webpieces-binary` | **no key** | Settled in `GUARD_MATRIX.md`: *"If L0 is off, nothing downstream can be trusted — you would be configuring the guards with a config file the validator could not check."* |
| **L1** | `location` | **no key** | It has **none today**, so adding one ADDS a knob in a fewer-knobs change. And top-level `excludePaths` already IS L1's per-path off switch (`filterByExcludedPaths` in `runner.ts`; `guards/L1-location.md` calls it "the filter"), so a `location` key would be a second spelling of a decision that already has one — CLAUDE.md shim shape #1. |

**The rule this expresses: L0 and L1 are STRUCTURAL; L2, L3 and L4 are POLICY. Only policy gets
a switch — and you audit what you cannot turn off.** That asymmetry is why #626 built the `L0-shim/`
and `L1-location/` streams: they are the only visibility into layers with no knob.

The launch guarantee itself is no longer a layer at all, and therefore not a candidate for a key. It is
a property of the registration: both hooks are registered with an ABSOLUTE
`$CLAUDE_PROJECT_DIR/…` path, so they resolve from any cwd. The relative registration they replaced was
what forced a whole extra guard into existence — a relative hook that cannot resolve exits 127, which
the harness treats as a non-blocking error and lets the call **proceed unguarded** — and it bought
nothing, because a linked worktree has no `node_modules` and always executed the MAIN tree's binary
anyway (measured 2026-08-10).

## What becomes unreachable

| capability today | after | load-bearing? |
|---|---|---|
| `mode: OFF` on one of the four L2 guards (15 partial combinations) | one `branch-state.mode` | **No** — this IS the defect (`guards/L2-branch-state.md`). This repo runs all four `ON`. |
| `mode: OFF` on one of the four L4 guards | one `pr-lifecycle.mode` | **No** — "gate the push but not the merge" is incoherent; `commands.pr-gate.mode: OFF` is the real opt-out. |
| four independent `hangTimeoutMinutes` | one | **No** — all four tune the SAME refresher writing the SAME cache file. Four values for one timer is a bug surface. |
| per-class escape hatches | per-layer | **No** — a time-box on half a policy leaves the same split. |
| `upsertPrCommand`, `mergeCompleteCommand` | **deleted, no destination** | Already second spellings of `commands.guardHints.*`, which the config's own `guardHintsWhy` calls the source of truth. Removing them is further knob reduction. |
| per-rule `excludePaths` on a hook guard | unchanged | **Nothing lost** — no guard has one. Top-level `excludePaths` is untouched. |

## `RETIRED_CONFIG_KEYS` — the hard cut

Nine entries appended to `packages/tooling/rules-config/src/retired-config-keys.ts`, all
`RETIRED_SCOPE_RULE`, so `retiredRuleFor()` catches them before `unknownRuleError`. **No `?? legacyKey`,
no alias table** — each old key's read path is deleted in the same change.

Representative entry (the other eight follow the same shape, each naming its destination):

```ts
new RetiredConfigKey(
    RETIRED_SCOPE_RULE, 'feature-branch-guard', 'hookGuards.branch-state',
    'Replace all four L2 guard keys (feature-branch-guard, read-stale-guard, stale-main-bash-guard, ' +
    'merged-branch-bash-guard) with ONE "branch-state" entry: keep the "mode" they shared (use "OFF" ' +
    'only if all four were OFF), carry "branchNamingConvention" over from this key, and keep ONE ' +
    '"hangTimeoutMinutes" (all four tuned the same refresher).',
    '[feature-branch-guard]',
),
```

`branch-creation-guard` → `branch-cleanup` says every field carries over unchanged.
`pr-creation-or-push-guard` / `merge-in-progress-guard` additionally say where `upsertPrCommand` /
`mergeCompleteCommand` go (`commands.guardHints.*`).

## File-by-file

> Locate by SYMBOL, not line number — the tree moves.

**`packages/tooling/rules-config/src`**

| file | change |
|---|---|
| `main-sync-guard-configs.ts` | delete the four L2 `*Config` classes; add one `BranchStateGuardConfig`. Rewrite the docblock — it describes the class matrix as the config shape. |
| `rule-configs.ts` | delete the four L4 `*Config` classes; add `PrLifecycleGuardConfig`. Rename `BranchCreationGuardConfig` → `BranchCleanupGuardConfig`. Drop `upsertPrCommand` / `mergeCompleteCommand`. |
| `rule-schemas.ts` | `RULE_SCHEMAS`: nine out, three in. |
| `sections.ts` | `HOOK_GUARD_NAMES` → the three names. |
| `retired-config-keys.ts` | the nine entries. |
| `default-rules.ts` | re-key the guard defaults — `setup.spec.ts`'s seed-validates-clean spec fails the build if a required field has no documented default. |
| `index.ts` | drop every deleted `*Config` export (a barrel export left behind is the same defect one level out). |

**`packages/tooling/ai-hook-rules/src/core`**

| file | change |
|---|---|
| `load-rules.ts` | `BUILT_IN_RULE_MAP`: four L2 classes read `BranchStateGuardConfig`; four L4 classes read `PrLifecycleGuardConfig`. This is the "classes stay, switch merges" seam. |
| `rules/index.ts` | `loadBuiltInRules` looks the config up by RULE NAME. Add one small `configKeyFor(ruleName)` step so nine class names resolve to three keys. **The only genuinely new mechanism in the change.** |
| `runner.ts` | `checkConfigSync` compares `rule.name` against configured keys — it must compare CONFIG KEYS or all nine rules report unconfigured and fault Y fires on every call. See Risks. |
| `rules/*-guard.ts` (nine) | constructor param type only; no behaviour change. |

**Docs** — `GUARD_MATRIX.md` (config-key column; the "no key on purpose" paragraph),
`guards/L1-location.md` (**generated** — edit `l1-doc.ts`, then `pnpm guards:generate`; never hand-edit),
`guards/L2-branch-state.md`, `guards/L3-branch-cleanup.md`, `guards/L4-pr-lifecycle.md`.

## PR / publish ordering

The PreToolUse hooks run the **published** `@webpieces/*`, one release behind local source. This
change has the DUAL hazard: after the publish, the nine old keys are *rejected*.

| # | what | verified by |
|---|---|---|
| **PR 1** | **source only** — every file above. Repo config untouched. Docs ride here. | the packages' own vitest suites (tsconfig paths → local src). **Not** by watching live guard behaviour. |
| **Publish A** | release PR 1 | `scripts/publish-packages.sh`; confirm `bin` survives the `publishConfig.bin` hoist |
| **PR 2** | `pnpm-workspace.yaml` catalog bump **and** the `webpieces.config.json` 9→3 rewrite, **one commit** | the configured gate after `pnpm install` |

PR 2 is one commit because the pin bump is what simultaneously teaches the installed validator the
three new keys and makes the nine old ones fail. Splitting them leaves the repo one commit deep in an
invalid config — survivable (editing the config is an unconditional PASS, `pnpm install` is on the L0
cure allowlist) but a needless stall. This does not violate "source and config ship separately": PR 1
is the source PR, PR 2 ships no source.

**Do NOT put the new keys in `webpieces.config.json` in PR 1** — the published validator has no schema
for `branch-state` and `unknownRuleError` blocks every Bash/Edit. That is the documented deadlock.

## Consumer migration — one mechanical pass

The first tool call after `pnpm install` prints nine retirement errors, each naming its destination.

1. Delete the four L2 keys; add `branch-state` (`mode` = `"OFF"` only if all four were OFF; carry
   `branchNamingConvention` and ONE `hangTimeoutMinutes`).
2. Rename `branch-creation-guard` → `branch-cleanup`, value unchanged.
3. Delete the four L4 keys; add `pr-lifecycle` (`mode` = `"OFF"` only if all four were OFF).
4. Move any `upsertPrCommand` / `mergeCompleteCommand` value to `commands.guardHints.*`.

Nothing outside `hookGuards` changes.

## Risks

1. **`checkConfigSync` is keyed by rule name.** With nine rules behind three keys it will report all
   nine unconfigured and fire fault Y on every call after Publish A. **The single most likely
   functional break — spec it explicitly.**
2. **Confirm `load-config.spec.ts` runs on FIXTURES, not this repo's real `webpieces.config.json`.**
   If it loads the real file through local source, PR 1 goes red the instant the nine names are
   retired (the file still holds them) and the two-PR split becomes impossible. Check before starting;
   if real, point that loop at a fixture in a PR 0.
3. **`guards/L1-location.md` is byte-locked.** Hand-editing it fails the gate.

## Alternatives rejected

| alternative | why |
|---|---|
| **Four keys — add `location` for L1** | L1 has no key today, so this ADDS a knob; `excludePaths` is already its off switch. |
| **Six keys — one per layer including L0/L1** | A hook that fails to launch is a silent ALLOW, and the two structural layers are what make every later verdict trustworthy. See the table above. |
| **Two keys — fold L3 into L4** | `branch-cleanup` carries `autoReapMergedBranches` — unattended branch deletion, which each consumer should answer once, not inherit from a PR-flow switch. |
| **One key — `hookGuards: { mode }`** | Collapses work-here policy with PR flow; a repo with a different PR workflow would have to disable staleness protection to opt out of the gate. |
| **Keep nine, document the combinations** | The documentation already exists and the incoherent combination shipped anyway. Representability is the fix; prose is not. |
| **Alias table / `?? legacyKey`** | Forbidden by CLAUDE.md; `retired-config-keys.ts`'s own docblock records that the last alias table hid three renames so completely they could never be deleted. |
| **Source + config in one PR** | Deadlocks the session — the published validator rejects `branch-state` as unknown and blocks every Bash/Edit. |
