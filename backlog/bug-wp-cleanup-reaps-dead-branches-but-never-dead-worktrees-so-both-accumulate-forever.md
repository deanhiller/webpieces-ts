# BUG: `wp-cleanup` reaps dead branches but never dead worktrees — and a live worktree pins its branch, so both accumulate forever

**Package:** `@webpieces/pr-gate` + `@webpieces/rules-config`
**Version seen:** `0.4.492`
**Severity:** High — self-reinforcing. The worktree verdicts existed and were used only to BLOCK, never
to remove, so `branch-creation-guard` eventually refuses to create the next branch or worktree and its
only remaining remedies loosen its own cap. That is precisely the pressure that drove an agent to edit
`webpieces.config.json` in a real session (see the related report below).

**Source:**
- `packages/tooling/rules-config/src/merged-branches.ts:383-411` — builds a full `DeletableWorktree[]`
  (path, branch, reason, pr, `deletable`) and caches it in `.webpieces/merged-branches.json`.
- `packages/tooling/rules-config/src/merged-branches.ts:133` — `DeletableWorktree`'s own doc comment:
  *"Carries `path` (what `git worktree remove` takes) AND `branch` (what `git branch -D` takes
  afterwards) because reaping a worktree is always those two steps, in that order."* It was **designed
  for reaping**; the reaping was never wired up.
- `packages/tooling/rules-config/src/branch-reaper.ts:228` — the only place `verdicts.worktrees` is
  touched: passed straight through into the rewritten cache. Never acted on.
- `packages/tooling/pr-gate/src/scripts/commands/cleanup-command.ts:~114` — mentions worktrees once, to
  **exclude** worktree-held branches from the prompt as "mechanical, not a judgement call".
- `packages/tooling/ai-hook-rules/src/core/rules/branch-creation-guard.ts:580-625` — the sole consumer,
  which uses the verdicts to refuse a `git worktree add` and print reap commands nobody runs.
- `packages/tooling/pr-gate/src/scripts/commands/land-pr-command.ts` — zero occurrences of "worktree",
  so landing a PR from a worktree always left a corpse.

Related: [`bug-tree-recovery-forbids-git-checkout-main-in-the-primary-clone-where-it-is-the-easy-exit`](./bug-tree-recovery-forbids-git-checkout-main-in-the-primary-clone-where-it-is-the-easy-exit.md).
Same trap shape: the system knows exactly what is dead, uses that knowledge to block you, and ships no
remedy that deletes anything.

## The deadlock

1. A merged worktree holds its branch, so `computeMergedBranches` puts the branch in `keep` with
   `checked out in worktree '<path>' — remove that worktree before deleting the branch`.
2. Nothing removes the worktree. `wp-cleanup` reaped branches only.
3. So both accumulate. Observed twice in one day on this repo: one `wp-cleanup` run spared all three
   sibling worktree branches with that exact line, another spared seven.
4. `branch-creation-guard` then refuses the next `git worktree add` at `maxWorktrees`, and its fix
   options were "raise `maxWorktrees`" and "set `turnOffRuleUntilEpoch`" — both loosen the rule.

The instruction the guard *did* print (`git worktree prune && git worktree remove <path> && git branch
-D <names>`) is correct git and was still never run: an AI agent reads a raw `worktree remove` / `-D`
as destructive, asks permission, and stops. That is the same reason `wp-cleanup` had to exist for
branches in the first place — the fix is a command that does the deleting, not better wording.

## Repro

```bash
git worktree add ../wt-feature -b dean/feature origin/main
# …work, PR, squash-merge it…
pnpm wp-cleanup
# → "dean/feature: checked out in worktree '../wt-feature' — remove that worktree before deleting the branch"
# → the worktree is not mentioned at all. Repeat forever.
```

## Fix (implemented)

`WorktreeReaper` (rules-config) + `WorktreeCleanupSection` (pr-gate), wired into `wp-cleanup` **before**
the branch pass, since removing the worktree is what makes its branch reapable:

- Order is fixed: **archive the branch as a tag → `git worktree remove <path>` → `git branch -D`**. If
  the archive fails, nothing is removed (the rule `BranchArchiver` already enforces for branches).
- Never the primary clone; never the worktree the command is running in (`process.cwd()`'s containing
  tree, so a subdirectory counts); never `--force` — git's refusal on uncommitted/untracked files is
  the safety property, and a refusal is reported, not retried.
- Every removal logged to `.webpieces/hooks/branch-mutations.log` under phase `REAP_WORKTREE` with
  `recover=git worktree add -b <branch> <path> <archive-tag>` (verified by hand: plain
  `git worktree add <path> <tag>` restores at a detached HEAD and silently loses the branch name).
- `DeletableWorktree` now carries the branch's `classification` token, so probably-dead worktrees are
  PROMPTED about exactly like probably-dead branches (default `none`, non-TTY answers none and says so).
- `branch-creation-guard`'s worktree-cap remedy now leads with `pnpm wp-cleanup` — a remedy that
  deletes something — with the explicit git sequence kept below it as reference.
- `wp-land-pr`, when the branch it just landed is held by the worktree it is running in, prints the
  `cd <primary clone> && pnpm wp-cleanup` follow-up instead of the bare "delete the merged branch".

## Still open

`wp-land-pr` does not remove anything itself. It cannot: it executes inside the worktree holding the
branch it just landed, and a process that deletes its own cwd is the one thing every rail here refuses.
A future `--cleanup-from-primary` that re-execs in the primary clone would close it properly.
