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

## Open decisions

- **Which stage owns it?** `wp-review-upsert-pr` (stage ②, added in #513) is the natural home — it already
  runs `buildCommand`, so it is holding exactly the dirty tree to inspect, at the "can we proceed to
  review?" moment. `wp-finish-upsert-pr` is the alternative but is later, after more wasted work.
- **Keep or drop `validate-di-graph-unchanged`?** Once the gate owns "are generated artifacts committed",
  the nx target is redundant for the PR flow — though CI (`wp-check-pr`) may still want a check. Leaning
  drop: two mechanisms for one invariant is how they drift apart. If kept, reduce it to a pure semantic
  comparison (regenerated content vs committed content) with no `git status`.

## Before you start — worktree cap

This work runs alongside other tickets, each in its own worktree, so the default cap of 5 is too low.
Raise it to **10**: `hookGuards → branch-creation-guard → maxWorktrees: 10` (and `maxLocalBranches: 10`)
in `webpieces.config.json`. Neither key exists today — both are code defaults — so you are ADDING them;
confirm the installed validator accepts them before relying on it.

`webpieces.config.json` is git-tracked, so every worktree gets its copy from its branch. **If `origin/main`
already carries `maxWorktrees: 10`, you inherit it — change nothing.** If not, add it in this PR, and if
you hit a conflict on that key while syncing, take main's value.
