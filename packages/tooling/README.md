# `packages/tooling/` — the deliverable, not build scaffolding

> **If you navigated into this folder expecting lint config and build helpers, stop and re-read
> that assumption.** This directory is roughly as large as the framework in `packages/http` +
> `packages/core`, and that is not an accident of a heavy build. **This is one of the two products
> this repository ships:** an organizational engineering practice and the machine that enforces it
> on humans *and* AI agents. The framework is the other product. This one is separable — it ships to
> npm on its own and is adoptable without the framework.
>
> The full argument lives in [`../../docs/ENGINEERING-PRACTICE.md`](../../docs/ENGINEERING-PRACTICE.md).
> This file is the map of what's here and why it's the deliverable.

## Why this is a product, not infrastructure

An engineering convention is only real if a machine refuses the violating change. A wiki is advisory;
a linter with a growing allowlist rots; a big-bang migration never finishes; code review depends on a
human noticing on a Friday afternoon. And AI made all of that worse — an agent writes ten times the
code and has read *none* of your conventions.

So the conventions here are enforced at three points, each catching what the previous structurally
cannot, and installed into a codebase that predates them via a **ratchet** (`NEW_AND_MODIFIED_*` mode
+ `ignoreModifiedUntilEpoch`) that grandfathers legacy code and bites the moment you touch it — no
migration project. That mechanism, packaged and reusable across companies, is the thing being built.

## What each package is

| Package | Stage / role | What it does |
|---|---|---|
| **`ai-hook-rules`** | **Edit time** (PreToolUse hook) | Refuses an agent's bad write *before the code exists*, returning the reason and the fix. Also holds workflow guards (feature-branch, stale-read, merge-in-progress, PR/merge). The stage with no pre-AI equivalent. |
| **`code-rules`** | **Build time** (`wp-ci`, run by `pnpm build-all`) | ~30 diff-scoped validators, plus whole-repo invariants a single-file hook can't see (di-graph, import cycles, runtime-architecture, nx-wiring). Catches whatever bypassed the hook — a human in an editor, a different agent, a merge. |
| **`pr-gate`** | **PR time** (`wp-finish-upsert-pr`) | Re-runs the gate authoritatively before a PR is created/updated, and renders the risk dashboard. Local greens are convenience; this is the record. |
| **`rules-config`** | Shared core | One implementation of *what a rule is* — mode resolution, epoch expiry, suppression spelling — consumed by all three stages. The published schema for `webpieces.config.json`. |
| **`nx-webpieces-rules`** | Nx integration | Wires validation into the Nx build graph and the architecture visualizers. |
| **`eslint-rules`** | ESLint bridge | The few checks that genuinely belong as lint plugins. |
| **`dev-config`** | Shared config | Common tsconfig/build settings. |

## The one file that turns it into *your* org's practice

The engine is published; the **dials are per-repo**, in the root
[`webpieces.config.json`](../../webpieces.config.json). Each rule carries three:

- **`mode`** — the ratchet. `OFF` → `NEW_AND_MODIFIED_CODE` → `…FILES` → `RUN_EVERY_TIME`. Scoping,
  not severity: how much of a diff (or the repo) the rule looks at.
- **`ignoreModifiedUntilEpoch`** — time-boxes a rollout. A rule can be live and visible but not yet
  biting until a date in version control that arrives by itself.
- **`disableAllowed`** — whether a reasoned `// webpieces-disable <rule> -- <why>` escape hatch exists
  at all.

Read the **suppression census** as a signal about the *rule*, not the engineer:

```bash
grep -rho "webpieces-disable [a-z-]*" --include="*.ts" packages apps | sort | uniq -c | sort -rn
```

A handful = the hatch working. A cluster in one layer = fix the rule's `allowedPaths`. Hundreds spread
across the repo = the rule is miscalibrated; fix the rule, not the files.

## Where to go next

- [`../../docs/ENGINEERING-PRACTICE.md`](../../docs/ENGINEERING-PRACTICE.md) — the conventions, the
  three-stage machine, the ratchet, and how to roll it out in your own org.
- Each package's `responsibilities.md` — what that package does, in its own words.
- [`../../docs/architecture/testing-philosophy.md`](../../docs/architecture/testing-philosophy.md) —
  the append-only feature-testing convention that this machine exists to make enforceable.
