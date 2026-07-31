# BUG: `merge-in-progress-guard` tells the AI "do not run other commands" — and to memorize it — when it blocks only 4 git subcommands

**Package:** `@webpieces/ai-hook-rules`
**Version seen:** `0.4.499`
**Severity:** High — it instructs the AI to persist an overstatement into long-term memory, so the damage
outlives the session that read it. It is the most plausible ancestor of the `git add` bug fixed in #514.

**Source:** `packages/tooling/ai-hook-rules/src/core/rules/merge-in-progress-guard.ts:16-22` (the fixHint),
`:60` (`BLOCKED_GIT_SUBCOMMANDS`)

Related: PR #514 (the `git add` correction), and
[`bug-guard-allowlist-matches-raw-command-string-so-a-pipe-blocks-its-own-remedy`](./bug-guard-allowlist-matches-raw-command-string-so-a-pipe-blocks-its-own-remedy.md).

## What it actually blocks

```ts
const BLOCKED_GIT_SUBCOMMANDS: readonly string[] = ['commit', 'push', 'merge', 'rebase'];
```

…plus `gh pr create|edit|merge`. That is the entire enforcement surface. Everything else — `git add`,
`git status`, `git diff`, builds, tests, installs, every read — runs fine.

## What it says

```
'Add to memory: while a merge is in progress, do not run other commands — finish it with the
 command above first.'
```

**"Other commands" is unbounded.** Read literally it means *every* command that is not the finish
command. That is the opposite of what resolving a merge requires: you must read the conflicted files,
run the build, run tests, and `git add` your resolutions. The guard's own paired tool
(`merge-end.ts:132`) hard-fails with `❌ Git still reports unmerged files … Resolve and \`git add\` them`
— so the tool demands exactly what this hint forbids.

## Why "Add to memory" makes it much worse

Every other overstatement in this repo was a doc that drifted and could be corrected in one edit. This
one asks the agent to **write the overstatement into its persistent memory**, where it will be recalled
in future sessions, in other repos, long after the text is fixed. An agent that obeys it will refuse to
run the build during a merge — and the merge cannot be finished without the build.

The `git add` prohibition that #514 removed from three separate documents most likely originated here
and propagated outward. Fixing the sources without fixing the memory instruction leaves the generator
in place.

## Suggested fix

- **State the actual list.** "While an unvalidated merge is in progress, `git commit`, `git push`,
  `git merge`, `git rebase`, and `gh pr create|edit|merge` are blocked — the finish command does the
  commit." Enumerating it is both shorter and true.
- **Say explicitly what IS expected**, since it is counterintuitive: resolve the files, `git add` them,
  write the merge explanations, run the build, then run the finish command.
- **Drop the "Add to memory" directive**, or narrow it to something that stays true: e.g. "finish a
  started merge before beginning other work." Never ask an agent to memorize a claim about which
  commands are blocked — that list is code and it changes; the memory does not.
- **Audit every other guard for `Add to memory:` directives** and apply the same test: would this still
  be true in six months, in a different repo, at a different version? Anything that fails that test does
  not belong in persistent memory.

## Before you start — worktree cap

This work runs alongside other tickets, each in its own worktree, so the default cap of 5 is too low.
Raise it to **10**: `hookGuards → branch-creation-guard → maxWorktrees: 10` (and `maxLocalBranches: 10`)
in `webpieces.config.json`. Neither key exists today — both are code defaults — so you are ADDING them;
confirm the installed validator accepts them before relying on it.

`webpieces.config.json` is git-tracked, so every worktree gets its copy from its branch. **If `origin/main`
already carries `maxWorktrees: 10`, you inherit it — change nothing.** If not, add it in this PR, and if
you hit a conflict on that key while syncing, take main's value.
