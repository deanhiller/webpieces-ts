# BUG: the `wp-land-pr` `package.json` script entry is redundant, and user-facing text references the command without `pnpm`

**Package:** repo root `package.json`, `@webpieces/ai-hook-rules`, `@webpieces/pr-gate`
**Version seen:** `0.4.499`
**Severity:** Low — cosmetic, but it is an inconsistency an AI reads as meaningful, and a bare
`wp-land-pr` is not a command anyone can actually run.

**Source:**
- `package.json:18` — `"wp-land-pr": "wp-land-pr"`
- `packages/tooling/ai-hook-rules/src/core/rules/pr-merge-guard.ts:46` — bare `` `wp-land-pr` `` inside a fix hint
- `packages/tooling/pr-gate/src/scripts/wp-land-pr.ts:13` — bare `'wp-land-pr'` in the CLI description

## Part 1 — delete the script entry

The root `package.json` has exactly one `wp-*` script:

```json
"wp-land-pr": "wp-land-pr"
```

Every other `wp-*` command — `wp-start-upsert-pr`, `wp-review-upsert-pr`, `wp-finish-upsert-pr`,
`wp-cleanup`, `wp-check-pr`, `wp-start-update`, `wp-finish-update` — has **no script entry at all**.
`pnpm` resolves them straight out of `node_modules/.bin`, which is why `pnpm wp-cleanup` works today
with nothing declared.

So the entry adds nothing and makes `wp-land-pr` look special when it is not. **Delete it**, and confirm
`pnpm wp-land-pr` still resolves afterwards (it should, via `.bin`, exactly like its siblings).

## Part 2 — every user-facing reference must be runnable

A bare `wp-land-pr` is not something an agent or human can type. Anything an agent READS as an
instruction must be the full `pnpm wp-land-pr`.

Audit and fix all **user-facing strings** — fix hints, stdout, `*.md` docs, generated
`.webpieces/instruct-ai/**`, and `.claude/commands/*.md`:

- `pr-merge-guard.ts:46` — `'and `wp-land-pr` passes exactly the pair that `wp-finish-upsert-pr` already rendered:'`
  → this sits inside a block an agent follows; make it `pnpm wp-land-pr`.
- `wp-land-pr.ts:13` — the CLI self-description; decide whether the usage line should show the full form.

Already correct, leave alone: `pr-merge-guard.ts:40` and `:48`, and `land-pr-command.ts:60`
(`'Then re-run `pnpm wp-land-pr` if the PR still needs landing.'`).

**Doc comments and test names are prose, not instructions** — `land-pr-command.ts:18`, `pr-gate-app.ts:57`,
`pr-gate-config.ts:128`, and the `*.spec.ts` describe/it strings may keep the bare form.

**While you are in there, apply the same test to every other `wp-*` command.** If any user-facing string
names one without `pnpm`, fix it too — this is a class of defect, not one instance.

## Do not regress the guard

`pr-merge-guard.spec.ts:49-51` asserts `pnpm wp-land-pr` and `pnpm wp-land-pr && pnpm wp-cleanup` pass the
guard. Keep those green — and if you change any hint text, update
`pr-merge-guard.spec.ts:66` (`'names wp-land-pr in the fix hint'`) to match.

## Before you start — worktree cap

This work runs alongside other tickets, each in its own worktree, so the default cap of 5 is too low.
Raise it to **10**: `hookGuards → branch-creation-guard → maxWorktrees: 10` (and `maxLocalBranches: 10`)
in `webpieces.config.json`. Neither key exists today — both are code defaults — so you are ADDING them;
confirm the installed validator accepts them before relying on it.

`webpieces.config.json` is git-tracked, so every worktree gets its copy from its branch. **If `origin/main`
already carries `maxWorktrees: 10`, you inherit it — change nothing.** If not, add it in this PR, and if
you hit a conflict on that key while syncing, take main's value.
