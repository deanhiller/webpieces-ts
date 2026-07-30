# BUG: `tree-recovery` tells the primary clone "never `git checkout main`" — the one case where it is the easy exit — and the guards then have no non-config escape

**Package:** `@webpieces/ai-hook-rules`
**Version seen:** `0.4.490`
**Severity:** High — an AI agent wedged twice in one session on `mealco-internal/monorepo-nx` and needed a
human to say "this branch is merged so you can git checkout main and delete it." The agent's escape was
to edit `webpieces.config.json` and loosen a guard, which is the opposite of what the guard exists to do.

**Source:**
- `packages/tooling/ai-hook-rules/src/core/rules/tree-recovery.ts:56-69` (the `kind === 'branch'` arm)
- `packages/tooling/ai-hook-rules/src/core/rules/merged-branch-message.ts:61-64` (the allowance list)
- `packages/tooling/ai-hook-rules/src/core/rules/branch-creation-guard.ts:387-402, 465` (the cap + its remedies)

Related: [`bug-merged-branch-guard-fails-open-on-bash-lets-a-whole-session-run-on-a-merged-branch`](./bug-merged-branch-guard-fails-open-on-bash-lets-a-whole-session-run-on-a-merged-branch.md),
[`bug-read-stale-guard-has-no-bash-counterpart-content-reading-bash-reasons-over-stale-main`](./bug-read-stale-guard-has-no-bash-counterpart-content-reading-bash-reasons-over-stale-main.md).
Those are about guards failing open. This one is about a guard failing *closed* with no advertised way out.

## 1. The parenthetical leaked from the worktree case into the primary-clone case

`tree-recovery.ts` already models the distinction correctly in two of its three arms:

```ts
if (kind === 'worktree') {
    return ['You are in a linked worktree. Start the new work in its own worktree:', ...worktreeForm];
}
if (kind === 'branch') {
    return ['Start fresh — branch off origin/main (never `git checkout main`):', ...branchForm];  // <-- here
}
return [
    'Start fresh off origin/main. Pick the form for the tree you are in:',
    '  - in the primary clone:',
    ...branchForm.map(…),
    '  - in a linked worktree (`git checkout main` fatals there):',   // <-- correct: scoped to worktrees
    ...worktreeForm.map(…),
];
```

The fallback arm gets it right — `git checkout main` fatals **in a linked worktree**, because main is
checked out elsewhere. The `kind === 'branch'` arm is the **primary clone**, where `git checkout main`
is not only safe, it is the shortest path off a merged branch. It carries the worktree warning anyway.

The spec even states the true reason (`read-stale-guard.spec.ts:258`): *"never `git checkout main`,
which fatals in a worktree."* The condition is in the test name and missing from the message.

**Fix:** drop the parenthetical from the `kind === 'branch'` arm, or scope it —
`(in a linked worktree use the worktree form below instead)`.

## 2. It contradicts the allowance list four lines later

`merged-branch-message.ts:61-64` prints, in the same output:

```
Still allowed while this block is up (these get you OFF this branch — run one, then retry):
  - switching away: git checkout/switch <other-branch>, git worktree add/remove/prune
```

`main` **is** an `<other-branch>`. So the same message forbids and permits the same command. A reader
resolving the conflict in favour of the explicit prohibition — which is what happened — concludes the
only exit is creating a new branch.

## 3. …and creating a branch is exactly what is blocked, with no remedy that deletes anything

`branch-creation-guard` then refused, because the repo sat at 6 local branches against
`maxLocalBranches: 5`. Its remedies (`branch-creation-guard.ts:465`):

```
Fix Option 1: If you genuinely need more branches in flight, raise branch-creation-guard.maxLocalBranches
Fix Option 2: To bypass this once, set branch-creation-guard.ignoreModifiedUntilEpoch
```

Both loosen the rule. **Neither is "delete a branch you no longer need"** — the obvious fix for *too many
branches*. `wp-cleanup` is pointed at elsewhere but reaped nothing (all six were closed-unmerged or had no
PR; see the companion `wp-cleanup` item). So every printed path led to editing config, and that is what
the agent did.

**Fix:** add a remedy listing deletable candidates with tip SHA and PR state, and offer to delete. Consider
letting `branch-creation-guard` allow one over-cap branch when `merged-branch-bash-guard` is the thing
demanding a new branch — otherwise two individually-correct guards compose into a trap.

## Repro

Primary clone (not a worktree), current branch's PR just merged, local branch count at `maxLocalBranches`.
`merged-branch-bash-guard` blocks Bash pending a new branch; `branch-creation-guard` refuses one;
`wp-cleanup` reaps nothing. The message says never to checkout main. Nothing left but a config edit.

The human fix was one command the guard had told the agent never to run:

```bash
git checkout main && git pull origin main && git branch -D <merged-branch>
```
