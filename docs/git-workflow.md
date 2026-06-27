# Git Workflow

**READ THIS BEFORE RUNNING ANY GIT COMMANDS ON A FEATURE BRANCH.**

## The 3-Point Fork-Point System

This repo enforces a specific merge discipline that preserves clean fork-point history. Violating it breaks code review tooling and automated checks.

The three points are:
- **A** — fork point: `git merge-base origin/main HEAD` — the last common ancestor between your branch and main
- **B** — feature HEAD: your current `HEAD`
- **C** — main HEAD: `origin/main`

The fork point **only stays valid** if you update from main using the squash-update process described below. Direct `git merge origin/main` or `git rebase origin/main` creates a merge commit that shifts A forward in a way that breaks the diff range used by PR review and AI code analysis tools.

---

## Rules (enforced by AI hooks)

### Creating a new branch

**You MUST be on `main`** to create a new feature branch.

```bash
git checkout main
git pull origin main
git checkout -b my-feature-name
```

If you are on a non-main branch and need a sub-branch:
```bash
git checkout -b sub/my-sub-feature    # "sub/" prefix required
```

The AI hooks will block any branch creation that violates these rules.

### Updating your feature branch from main

**NEVER run:**
- `git merge origin/main`
- `git merge main`
- `git rebase origin/main`
- `git rebase main`
- `git pull origin main` (while on a feature branch)

These are all blocked by the `no-direct-main-update` AI hook.

**ALWAYS use the squash-update script:**
```bash
./scripts/git-updateFromMain.sh
```

This script performs a 3-point squash merge that preserves fork-point A correctly:
1. Identifies fork point A = `git merge-base origin/main HEAD`
2. Creates a squash branch off latest main (C)
3. Squash-merges all commits between A and B onto the new base
4. Force-pushes the squash result back as your feature branch

The net result: your branch contains all your changes, rebased onto latest main, with no merge commits, and with fork point A correctly pointing to the current main tip.

### Creating a PR

Before running `gh pr create`, your branch must be up-to-date with `origin/main` (i.e., `origin/main` must be an ancestor of your HEAD). The `pr-creation-guard` AI hook verifies this by checking `git merge-base --is-ancestor origin/main HEAD`.

If the check fails:
```bash
./scripts/git-updateFromMain.sh    # sync first
gh pr create ...                    # then create PR
```

---

## Detecting bad history

If you suspect broken fork-point history, check for merge commits between A and HEAD:
```bash
A=$(git merge-base origin/main HEAD)
git log --merges $A..HEAD
```

If this shows any commits, the squash-update process was bypassed. Fix by running `./scripts/git-updateFromMain.sh`.

---

## Branch naming conventions

| Situation | Naming |
|-----------|--------|
| New feature from main | `feature-name` or `fix-something` |
| Sub-branch from a feature branch | `sub/sub-feature-name` |

The `sub/` prefix tells the `branch-creation-guard` AI hook that you intentionally branched from a non-main branch. Without it, the hook will block and ask you to rename.
