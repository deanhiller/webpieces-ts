# BUG: `wp-land-pr` cannot reap the worktree it is standing in, so landing from a worktree always leaves a corpse

**Package:** `@webpieces/pr-gate`
**Version seen:** `0.4.499`
**Severity:** Medium — no data loss, but every PR landed from a worktree leaves a dead directory and
branch behind, and branch/worktree accumulation is what trips `branch-creation-guard` and wedges sessions.

**Source:** `packages/tooling/pr-gate/src/scripts/commands/land-pr-command.ts`

Follow-up to [`feature-archive-deleted-branches-as-tags-and-split-merge-info-into-staged-and-merged`](./feature-archive-deleted-branches-as-tags-and-split-merge-info-into-staged-and-merged.md)
(#510) and [`bug-wp-cleanup-reaps-dead-branches-but-never-dead-worktrees-so-both-accumulate-forever`](./bug-wp-cleanup-reaps-dead-branches-but-never-dead-worktrees-so-both-accumulate-forever.md)
(#512), which recorded this as **"Still open"**.

## The situation

`wp-land-pr` squash-merges the current branch's PR. It exists because a UI merge cannot produce the
compact risk/flags commit body — only an explicit `gh pr merge --subject --body-file` can — so it covers
`mergeMode=NONE` repos and PRs whose checks were still running when `wp-finish-upsert-pr` ran.

After it lands, the branch is dead. But `wp-land-pr` **runs inside the worktree holding that branch**, so
removing the worktree would delete the directory the running process is standing in. Every rail in
`WorktreeReaper` (#512) exists to refuse exactly that: *never remove the tree containing `process.cwd()`*.

#512 took this to an honest halfway point — `wp-land-pr` now detects "the tree I am in holds the branch I
just landed" and prints:

```
cd <primary-clone-path> && pnpm wp-cleanup
```

naming the exact directory. That is correct but manual, and it is the step most likely to be skipped,
because the PR is already landed and the work feels done.

## What a real fix needs

`wp-land-pr` must **re-exec in the primary clone** after landing, so the reap runs from a tree that is not
the one being removed. Sketch — verify each step rather than trusting this outline:

1. Land the PR as today.
2. Resolve the primary clone via `WorktreeService` (it already distinguishes primary from linked).
3. Re-exec (or spawn) the cleanup phase with `cwd` = primary clone.
4. Archive-tag the branch, `git worktree remove <path>`, `git branch -D <branch>` — the exact order
   `WorktreeReaper` already enforces, reusing it rather than reimplementing.

## Constraints that must survive

- **Never `--force`.** Git's refusal on uncommitted or untracked files is a feature; report and stop.
- **Never remove the primary clone**, and never remove a tree still holding unmerged work.
- **Log to `.webpieces/hooks/branch-mutations.log`** with phase `REAP_WORKTREE` and a working
  `recover=` line. Note the verified form is `git worktree add -b <branch> <path> <tag>` — **the `-b` is
  required**; without it the restore lands at a detached HEAD and silently loses the branch name.
- If re-exec is not safely achievable, **say so and keep the notice** rather than shipping a half-reap.
  A wedge or an honest limitation beats a command that deletes its own working directory mid-run.

## Before you start — worktree cap

This work runs alongside other tickets, each in its own worktree, so the default cap of 5 is too low.
Raise it to **10**: `hookGuards → branch-creation-guard → maxWorktrees: 10` (and `maxLocalBranches: 10`)
in `webpieces.config.json`. Neither key exists today — both are code defaults — so you are ADDING them;
confirm the installed validator accepts them before relying on it.

`webpieces.config.json` is git-tracked, so every worktree gets its copy from its branch. **If `origin/main`
already carries `maxWorktrees: 10`, you inherit it — change nothing.** If not, add it in this PR, and if
you hit a conflict on that key while syncing, take main's value.
