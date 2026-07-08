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
