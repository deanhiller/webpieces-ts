# BUG: `branch-creation-guard` tells you to delete worktrees that agents are actively working in, and miscounts parked branches

**Package:** `@webpieces/ai-hook-rules`
**Version seen:** `0.4.499`
**Severity:** Critical — the remedy it prints is a copy-pasteable command that DELETES LIVE WORK. Observed
2026-07-30 with three subagents mid-task; the guard listed all three of their worktrees as dead and
offered a single `git worktree remove … && git branch -D …` line covering every one of them.

**Source:**
- `packages/tooling/ai-hook-rules/src/core/rules/branch-creation-guard.ts` (the worktree cap + its remedies)
- `packages/tooling/rules-config/src/merged-branches.ts` (`classifyWorktrees`, and the branch-verdict builder)

Related: [`bug-tree-recovery-forbids-git-checkout-main-in-the-primary-clone-where-it-is-the-easy-exit`](./bug-tree-recovery-forbids-git-checkout-main-in-the-primary-clone-where-it-is-the-easy-exit.md)
(same guard, the remedies-only-loosen-config half, fixed in #509),
[`bug-wp-cleanup-reaps-dead-branches-but-never-dead-worktrees-so-both-accumulate-forever`](./bug-wp-cleanup-reaps-dead-branches-but-never-dead-worktrees-so-both-accumulate-forever.md) (#512).

## Defect 1 — a freshly created worktree is classified "dead"

Verbatim, while three agents were working:

```
You have 8 linked worktrees; the cap (branch-creation-guard.maxWorktrees) is 5. 7 of them are dead
(merged branch, no commits, or a missing directory) and can be removed right now.
  Fix Option 1: (preferred) Remove these 7 dead worktrees — each holds a branch backed by a MERGED PR,
  a branch with no commits of its own, or a directory that is already gone, so no work can be lost …
  git worktree prune && git worktree remove …-apipath && git worktree remove …-banner
  && git worktree remove …-digraph && … && git branch -D dean/api-scanner-path-required
  dean/finish-pr-banner-honestSquash dean/di-graph-gate-merge-aware …
```

`…-apipath` and `…-banner` had **live agents in them**. They qualified as dead under *"a branch with no
commits of its own"* — which every worktree satisfies for the entire window between `git worktree add -b
… origin/main` and its first commit. That is exactly the window in which an agent is doing its work.

The claim *"so no work can be lost"* is therefore false, and it is the sentence most likely to stop a
careful agent from double-checking.

Note `dean/finish-pr-banner-honestSquash` appears in the delete list — a `*Squash` snapshot exists
**only while a sync is in flight**, so its presence is positive evidence that a session is mid-flight.

## Defect 2 — the parked-branch count is fiction

Minutes later, same guard:

```
You have 8 parked local branches (not counting any checked out in a worktree);
the cap (branch-creation-guard.maxLocalBranches) is 5. None of them are dead …
```

Actual state at that moment (`git branch --list`): **5 branches total**, of which 3 were checked out in
worktrees and 1 was `main` — so **1** parked branch, not 8. It was counting branches deleted minutes
earlier, i.e. reading a stale `.webpieces/merged-branches.json` while claiming a fresh refresh
timestamp. It then blocked a legitimate `git worktree add` on that phantom count.

## Why this is worth fixing above everything else

`wp-cleanup` at the same version gets this **right** — run immediately after, it reaped exactly the three
genuinely-merged worktrees and correctly spared the fourth with `PR #514 is OPEN (not merged); holds 1
unique commit(s)`. So the correct verdict logic exists and is already shipped; `branch-creation-guard`
is not using it, or is using a stale cache of it.

## The fix (settled — implement this)

### 1. Liveness is "live unless merged" — the SAME rule branches already use

Do not invent worktree liveness heuristics. Mtime, locks, and `*Squash`/`*PreMerge` siblings are all
leaky, and none is needed. A branch is reapable when its PR is **merged**; a worktree is reapable on
exactly the same evidence. **"No commits of its own" must stop being a death sentence entirely** — it is
the normal state of a worktree from `git worktree add -b … origin/main` until its first commit, i.e.
precisely while an agent is working in it.

Anything not provably merged is **live**, and live means: do not offer to delete it without an explicit
human answer.

### 2. Reuse the recorded status — do not re-derive it

The async refresher already writes worktree and branch status into `.webpieces/merged-branches.json`, and
`wp-cleanup` reads it to produce correct verdicts (`superseded` / `never-proposed` /
`content-already-in-main` / `prunable-worktree` / `locked-worktree` / `current-worktree` /
`detached-worktree`). **Verify the refresher records status for EVERY worktree and EVERY branch** — if it
does not, extend it; that is the fix, not a second classifier inside the guard.

### 3. The guard should stop printing deletion commands at all

`branch-creation-guard` has no business owning reaping logic. `wp-cleanup` already classifies, prompts,
archive-tags before deleting, and refuses to remove the tree it is standing in. The guard should say:

> You are at the cap — run `pnpm wp-cleanup` (it archives before deleting and asks before removing
> anything that is not provably dead).

**Never emit a chained `git worktree remove … && … && git branch -D …` one-liner.** A single command
deleting seven things has no safe partial failure, and it is the exact line that would have destroyed
live agent work.

### 4. Fix the count

Recompute or invalidate the cache before printing any number. If the cache is stale, say so rather than
asserting a figure — it reported 8 parked branches when there was 1, then blocked on that fiction.

## Before you start — worktree cap

Parallel ticket work runs several subagents at once, each in its own worktree, so
`hookGuards → branch-creation-guard → maxWorktrees` is **10** in `webpieces.config.json`.
`maxLocalBranches` stays at **5** deliberately — branches outside a worktree are worked one at a time.

Both keys are already on `origin/main`, so you inherit them: **change nothing.** If you hit a conflict on
those lines while syncing, take main's value.
