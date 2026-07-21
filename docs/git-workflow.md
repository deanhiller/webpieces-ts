# Git Workflow

**READ THIS BEFORE RUNNING ANY GIT COMMANDS ON A FEATURE BRANCH.**

> The always-current, authoritative version of this flow is regenerated on every `wp-*` command at
> **`.webpieces/instruct-ai/webpieces.git-workflow.md`** (it can't drift). This file is the human
> overview; when in doubt, read the generated one.

## The 3-Point Fork-Point System

This repo enforces a merge discipline that preserves clean fork-point history. Violating it breaks code
review tooling and automated checks.

The three points are:
- **A** — fork point: `git merge-base origin/main HEAD` — last common ancestor of your branch and main
- **B** — feature HEAD: your current `HEAD`
- **C** — main HEAD: `origin/main`

The fork point **only stays valid** if you update from main using the squash-update commands below.
Direct `git merge origin/main` / `git rebase origin/main` creates a merge commit that shifts A forward
and breaks the diff range used by PR review and AI code analysis. These are blocked by the
`redirect-how-to-merge-main` AI hook.

---

## Rules (enforced by AI hooks)

### Creating a new branch

**You MUST branch off fresh `main`.** Name it `{whoami}/<short-feature-description>` — lowercase, no
version numbers, no `sub/` prefix (e.g. `dean/upgrade-webpieces`). The `branch-creation-guard` blocks
anything else. Sub-branches (branching off another feature branch) are disabled; to allow one
temporarily, set `branch-creation-guard.ignoreModifiedUntilEpoch` to a future epoch in
`webpieces.config.json`.

**Primary clone:**
```bash
git checkout main
git pull origin main
git checkout -b dean/my-feature
```

**Worktree:** do **not** `git checkout main` inside a linked worktree (git refuses — `main` is checked
out in the primary). Add a worktree branched straight off fresh main instead:
```bash
git fetch origin main
git worktree add ../my-feature -b dean/my-feature origin/main
cd ../my-feature
```
The explicit `origin/main` base is **required** — `branch-creation-guard` treats `git worktree add -b`
as a branch creation, so it obeys the same rules as `git checkout -b` (no stacking on a feature branch,
no reserved `wp<number>` suffix).

### Two budgets: 5 branches, 5 worktrees

`branch-creation-guard` caps **parked branches at 5** (`maxLocalBranches`) and **linked worktrees at 5**
(`maxWorktrees`). They are separate budgets: a branch checked out in a worktree counts against the
worktree cap, *not* the branch cap — so 5 worktrees plus 5 parked branches is fine, but a 6th of either
is blocked at creation until you reap the dead ones.

Creation is the gate because it is the only moment cleanup is both cheap and obviously worth it. When
blocked, the guard names exactly what is dead and hands you the command; `.webpieces/merged-branches.json`
carries the per-branch and per-worktree reason. Reaping a worktree is always prune → remove → delete, in
that order — git refuses to delete a branch a worktree still holds:
```bash
git worktree prune && git worktree remove ../old-feature && git branch -D dean/old-feature
```
A branch is only ever proposed for deletion when it is backed by a **merged PR** or holds **no commits of
its own**. Anything else is spared for a human to decide.

Checking a *dead* branch out into a new worktree is blocked too: `git worktree add ../dir <merged-branch>`
would materialize a directory full of pre-merge code. Base it on fresh main instead
(`git worktree add ../dir -b <new> origin/main`).

### A merged worktree is a dead worktree

`read-stale-guard` blocks **reads** — not just edits — once the branch you are on has a merged PR, in a
worktree exactly as in the primary clone. (This is the case the old main-only guard could never see: a
linked worktree can never have `main` checked out, so "is main stale?" never fired in one.) Everything in
that tree is a pre-merge snapshot. The block prints the cure for the tree you are actually in — the
`git worktree add … origin/main` form in a worktree, `git checkout -b … origin/main` in the primary clone —
and, in a worktree, the prune → remove → delete reap for the dead tree itself. A **dirty** tree fails open
so uncommitted work can always be read and rescued; Bash, Write/Edit and `webpieces.config.json` stay
readable regardless.

### A fresh worktree needs its own `pnpm install`

git does not copy `node_modules` into a new worktree, and the committed hook shim resolves the guard
binary relative to the tree it lives in — so the first tool call in a brand-new worktree fails **closed**
with "not installed". Run `pnpm install` **in the worktree** (the primary clone's `node_modules` does not
serve it); the fail-closed shim always allows that command.

### Updating your feature branch from main

**NEVER run** `git merge origin/main`, `git merge main`, `git rebase origin/main`, `git rebase main`,
or `git pull origin main` on a feature branch — all blocked by `redirect-how-to-merge-main`.

**ALWAYS use the squash-update commands** (worktree-native — they branch off `origin/main` and never
check out local `main`):
```bash
pnpm wp-start-update     # 3-point squash-update from main (standalone, no PR)
# clean merge  → finalizes automatically (nothing else to run)
# conflicts    → /wp-merge to resolve, then:
pnpm wp-finish-update    # finalize after you've resolved conflicts
```

### Creating a PR

Manual `git push` and direct PR creation (`gh pr create`, `gh api .../pulls`, curl) are blocked by
`pr-creation-or-push-guard`. Everything goes through the gated flow, which updates from main, runs the
real build, and pushes for you:
```bash
pnpm wp-start-upsert-pr    # update from main + advisory build, then tells you to write review.json
# resolve conflicts with /wp-merge if prompted
pnpm wp-finish-upsert-pr   # authoritative build gate, push, create/update the PR + dashboard
```

If a human genuinely needs an out-of-band push (no PR), they must run it themselves — a manual push
bypasses the build gate, `review.json`, and dashboard.

---

## Detecting bad history

If you suspect broken fork-point history, check for merge commits between A and HEAD:
```bash
A=$(git merge-base origin/main HEAD)
git log --merges $A..HEAD
```
Any commits here mean the squash-update was bypassed. Fix by running `pnpm wp-start-update`.

---

## Merge conflict resolution

When `wp-start-update` / `wp-start-upsert-pr` hit conflicts, they write the 3-point context under
`.webpieces/merge-info/<slug>/merge-<n>/` (A-forkpoint / B-feature / C-main plus `B-A.diff` / `C-A.diff`
per conflicted file) and hand resolution to you. The AI merge command lives at
`.claude/commands/wp-merge.md` and is launched with `/wp-merge`. After resolving, finish with
`pnpm wp-finish-update` (standalone) or `pnpm wp-finish-upsert-pr` (PR flow) — the tooling makes the
commit; you never `git commit` the merge yourself.

---

## Installing the webpieces rules in a new project

Install the **one** bundle package — `@webpieces/nx-webpieces-rules`. It pulls in everything: the AI
hooks (`@webpieces/ai-hook-rules`), the code validators (`@webpieces/code-rules`), the ESLint rules
(`@webpieces/eslint-rules`), the PR-gate commands (`@webpieces/pr-gate`), and the shared config
(`@webpieces/rules-config`). Do not also add `@webpieces/ai-hook-rules` directly — it comes transitively.

```bash
pnpm add -Dw @webpieces/nx-webpieces-rules   # -w for the monorepo root; drop -w in a single-package project
npx wp-install-ai-hooks                       # wire the hooks + seed webpieces.config.json
# Restart your Claude Code session
```

`wp-install-ai-hooks` wires **two independent `PreToolUse` hooks** into the chosen `settings.json`, each
invoked through the committed shim `.claude/webpieces/ai-hook.sh` (which the guards self-heal so it can't
go stale):
- `wp-ai-rules-hook` — matcher `Write|Edit|MultiEdit` — runs the code-style rules.
- `wp-ai-guards-hook` — matcher `Write|Edit|MultiEdit|Bash` — runs the git/PR/branch guards.

To move or uninstall, re-run `wp-install-ai-hooks` and pick a different target (or "none").
