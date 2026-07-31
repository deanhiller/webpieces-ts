# FEATURE: make the PR gate reject uncommitted build artifacts, replacing the per-project `validate-di-graph-unchanged` nx gate

**Package:** `@webpieces/pr-gate`, `@webpieces/nx-webpieces-rules`
**Version seen:** `0.4.499`
**Severity:** Medium — no wrong results, but the current gate cannot pass during a 3-point merge, nx
mislabels it "flaky", and it only polices `design.*` while any other stray build output goes unnoticed.

**Source:**
- `packages/tooling/nx-webpieces-rules/src/executors/validate-di-graph-unchanged/executor.ts`
- `packages/tooling/nx-webpieces-rules/src/di-graph-targets.ts` (`createValidateDiGraphUnchangedTarget`)
- `packages/tooling/nx-webpieces-rules/src/executors/validate-architecture-unchanged/executor.ts` (the sibling that does it differently)

## What the current gate does

`di-graph-generate` writes three checked-in files per project — `design.json` (machine-readable),
`design.md` (Mermaid, rendered by GitHub in PRs), `design.html` (viz.js page linked from
`architecture/dependencies.html`). `validate-di-graph-unchanged` then runs
`git status --porcelain -- <those paths>` and fails on any output.

So it uses **"is the working tree dirty here"** as a proxy for **"is the committed design stale"**. Those
are different questions.

Contrast the sibling gate, which has none of these problems:

| | `validate-architecture-unchanged` | `validate-di-graph-unchanged` |
|---|---|---|
| Regenerates | in memory | onto disk (`dependsOn: di-graph-generate`) |
| Oracle | regenerated content vs the artifact | `git status --porcelain` |
| Dirties the tree | no | **yes, as a side effect of validating** |
| Depends on git state | no | **entirely** |

## Consequence 1 — why nx calls it "flaky"

`cache: false` disables *caching*, not *hashing*. Nx still hashes tasks by input file **contents** and
flags a task flaky when one hash yields both a pass and a fail. This gate's real input is git state
("is this committed?"), which nx cannot see. Run fails (uncommitted) → you commit → run passes: same
contents, same hash, opposite results → "flaky task". It is not flaky, it is **stateful**. Two agents hit
this independently on 2026-07-30.

## Consequence 2 — it cannot pass mid-merge

During a 3-point merge the merged source exists only in the working tree. The gate demands a commit;
`merge-in-progress-guard` **blocks `git commit`**. So it demands an impossible command.

## The design

Move enforcement out of the nx target and into the PR gate, as ONE repo-wide check after `buildCommand`
runs. This is strictly more coverage than today (which only knows about `design.*`) and it deletes the
flaky label as a side effect, because nx stops owning a git-state-dependent task.

Two verdicts:

1. **A known generated file is dirty** → *"you did not run `<buildCommand>` and commit the regenerated
   design files, so the review cannot proceed."* Name the files and the exact command.
2. **Anything else is dirty** → hard stop: *"your build is generating uncommitted git artifacts, so I
   cannot continue the PR process. Either (1, best) write them to an output directory that is in
   `.gitignore`, or (2) add a new dir to `.gitignore`."* Nothing catches this today, and a build that
   dirties the tree unpredictably is a real defect rather than a paperwork failure.

### The predicate must be "committed OR staged"

This is what removes the merge problem **without a merge special-case**. `git status --porcelain` reports
index state in column 1 and worktree state in column 2:

- Normal flow: run the build, commit the design files. Passes.
- Mid-merge: `git commit` is blocked, but `git add` is expected (see
  [`bug-merge-in-progress-guard-fixhint-overstates-what-it-blocks`](./bug-merge-in-progress-guard-fixhint-overstates-what-it-blocks.md)
  and PR #514) and the gate commits. **Staged satisfies the contract.**

One rule, no exceptions, holds everywhere.

## Decisions (settled — implement these, do not re-open)

**Stage ② `wp-review-upsert-pr` owns the check.** It is the stage that RUNS `buildCommand`, so it is
already holding the dirty tree at the exact moment the question matters. `wp-finish-upsert-pr` is later,
after more work has been wasted.

**`validate-di-graph-unchanged` is DROPPED, not repaired.** The nx target and its
`createValidateDiGraphUnchangedTarget()` wiring both go. `di-graph-generate` STAYS — the design files are
still generated and still committed; only the git-state-dependent gate is removed.

The argument for keeping a CI-side copy was that someone could bypass the local flow and push directly.
**They cannot.** `finish-upsert-pr-command.ts:121-128` mints an HMAC gate token bound to the local HEAD
sha and writes it into the PR body; CI (`wp-check-pr`) recomputes it. Per that code, *"a valid token in
the PR body is proof this gated flow ran + passed on this exact commit."* A PR that skipped the flow has
no valid token and cannot merge. So a CI-side duplicate of this check has nothing left to catch, and
two mechanisms for one invariant is how they drift apart.

Per-project attribution is not lost: the gate names the offending files, and a path identifies its
project just as well as a per-project target did.

## Also delete, once the gate lands

- `createValidateDiGraphUnchangedTarget()` in `src/di-graph-targets.ts` and its registration in `plugin.ts`
- `src/executors/validate-di-graph-unchanged/**` and its `executors.json` entry
- The `di-graph` rule's staleness-gate semantics in `webpieces.config.json` — check whether the rule key
  still governs `di-graph-generate` (which stays) before removing anything from the config, and remember
  the published validator lags one release, so defer live-config edits if it would reject them.

## Before you start — worktree cap

Parallel ticket work runs several subagents at once, each in its own worktree, so
`hookGuards → branch-creation-guard → maxWorktrees` is **10** in `webpieces.config.json`.
`maxLocalBranches` stays at **5** deliberately — branches outside a worktree are worked one at a time.

Both keys are already on `origin/main`, so you inherit them: **change nothing.** If you hit a conflict on
those lines while syncing, take main's value.
