# L3 — branch cleanup

**Goal: which dead branches and worktrees get reaped?**

**Config key: `branch-creation-guard`.** Shipped, and it KEEPS that name. A rename to
`branch-cleanup-guard` was once proposed here and is rejected: this is already one class implementing one
policy, carrying real settings (`subBranchNaming`, `autoReapMergedBranches`, `maxLocalBranches`,
`maxWorktrees`) rather than pure boilerplate. The rename would cost a retirement entry, a migration and
prose churn across roughly ten files for zero policy change. L2 and L4 collapsed because four keys there
described ONE decision; nothing here needs collapsing.

**Code:** `ai-hook-rules/src/core/rules/branch-creation-guard.ts` ·
`rules-config/src/merged-branches.ts` (the classification ladders) ·
`rules-config/src/merged-branch-verdicts.ts` (the token vocabulary) ·
`rules-config/src/worktree-reaper.ts` · `pr-gate`'s `wp-cleanup` command.

> **STUB.** This layer is not yet tabled. What follows is what is already known from analysing it
> alongside L0–L2; the table and use cases still need the treatment L0, L1 and L2 have had — a row
> array in code, the doc rendered from it, and a spec locking the two byte-identical.

## What is already understood

The branch classification is **already close to the shape L0 and L2 are moving toward** — an ordered
first-match-wins ladder producing a token, with the prose travelling on the verdict object. Tokens live
in `merged-branch-verdicts.ts` as `CLASSIFICATION_*` constants plus an ordered
`PROMPTABLE_CLASSIFICATIONS` array.

Rough shape of the branch ladder, first match wins:

| # | condition | token | action |
|---|---|---|---|
| 1 | held in a worktree | `in-use` | spare, silently |
| 2 | own MERGED PR exists | `merged-pr` | auto-delete |
| 3 | name is a backup of a merged base | `backup-of-merged` | auto-delete |
| 4 | zero commits ahead of `origin/main` | `no-commits` | prompt |
| 5 | PR closed and superseded | `superseded` | prompt |
| 6 | content already in `main` (`git cherry`) | `content-already-in-main` | prompt |
| 7 | otherwise | `never-proposed` | prompt |

Worktree pre-emptions are checked BEFORE that ladder, first match wins: `isMain` → dropped ·
`prunable` → deletable · `locked` → spared · `path == repoRoot` → spared · detached → spared.

## Known gaps, not yet fixed

- **`prunable` is tested BEFORE `locked`**, so an auto-reap can override a human's `git worktree lock`.
- **A `locked` / `current` / `detached` worktree whose branch is provably dead is reported but has no
  cleanup path at all.**
- **The commits-ahead count is an `int` with `-1` meaning "unknown"** but is only ever tested as
  `=== 0` — a 3-valued enum in every decision. `-1` meaning "assume it has work" is deliberate; the
  message leaking the raw `-1` ("holds -1 unique commit(s)") is the bug.
- Unlike L0, there is **no completeness test and no shadowing test** — the specs are one hand-written
  `it()` per situation, so a missing classification would not be caught.

## What this layer mostly needs

A coverage test, not a redesign. The ladder is sound; what is missing is the generated cell universe and
the two structural assertions L0 already has (every combination matches exactly one row; no row is fully
shadowed).

## Code anchors

| section | file | symbol |
|---|---|---|
| branch classification | `rules-config/src/merged-branches.ts` | `classify`, `classifySpared`, `classifyWorktrees` |
| token vocabulary | `rules-config/src/merged-branch-verdicts.ts` | `CLASSIFICATION_*`, `PROMPTABLE_CLASSIFICATIONS` |
| creation caps | `ai-hook-rules/src/core/rules/branch-creation-guard.ts` | `effectiveBranchCap` |
| worktree reaping | `rules-config/src/worktree-reaper.ts` | — |
