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

These are all blocked by the `redirect-how-to-merge-main` AI hook.

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

---

## Merge conflict resolution script reference

| Script | Purpose |
|--------|---------|
| `./scripts/git-updateFromMain.sh` | Main entry point — squash-merge from main with optional AI conflict resolution |
| `./scripts/git-gatherInfo.sh` | Validates tree state and gathers A/B/C hash points (called by updateFromMain) |
| `wp-finish-upsert-pr` (`git-finishUpsertPr.ts`) | Validates AI conflict resolution, requires review.json, runs the build, then renders the dashboard and creates/updates the PR |
| `./scripts/.workflow/git-findForkPoint.sh` | Calculates fork point and detects illegal merge commits |
| `./scripts/.workflow/git-readAiBranchName.sh` | Converts branch name to safe directory name |
| `./scripts/.workflow/git-validateUpToDate.sh` | Verifies branch is up-to-date with origin/main |
| `./scripts/.workflow/cleanTmp.sh` | Removes .webpieces/ workflow dirs (merge-/review-/pr-) older than 30 days |

Merge context is saved to `.webpieces/merge-{branch-name}/` (gitignored, 30-day retention). When AI resolves conflicts, it reads A-forkpoint.txt, B-feature.txt, C-main.txt, B-A.diff, and C-A.diff for each conflicted file, then writes a `merge-summary.md` for human review.

The AI merge command lives at `.claude/commands/wp-merge.md` and is launched with:
```
/wp-merge
```

---

## Installing `@webpieces/nx-webpieces-rules` in a new project

Install the **one** bundle package — `@webpieces/nx-webpieces-rules`. It pulls in everything:
the AI hook (`@webpieces/ai-hook-rules`), the code validators (`@webpieces/code-rules`), the
ESLint rules (`@webpieces/eslint-rules`), the PR-gate scripts (`@webpieces/pr-gate`), and the
shared config (`@webpieces/rules-config`). Do **not** also add `@webpieces/ai-hook-rules`
directly — it comes transitively, and a direct dep is redundant.

### Single-package project

```bash
pnpm add -D @webpieces/nx-webpieces-rules
# If pnpm build approval is required:
pnpm approve-builds
```

The postinstall script automatically:
1. Creates `.webpieces/ai-hooks/claude-code-hook.js` (bridge to the npm package)
2. Merges a `PreToolUse` hook entry into `.claude/settings.json` if `.claude/` exists
3. Seeds `webpieces.config.json` if missing

### Monorepo-nx project

Add the package to the **root** `package.json` devDependencies (not a workspace package):

```bash
# From the monorepo root:
pnpm add -Dw @webpieces/nx-webpieces-rules
pnpm approve-builds   # if prompted
# Verify:
cat .webpieces/ai-hooks/claude-code-hook.js
```

In a pnpm workspace, the package is hoisted to the root `node_modules/`, so the postinstall fires once for the monorepo root. The hook file is created at the root `.webpieces/ai-hooks/claude-code-hook.js`.

### Global dispatch (machine-level, run once)

The global dispatch script (`~/.webpieces/ai-hooks/global-dispatch.js`) delegates to each project's own hook, so any project with `.webpieces/ai-hooks/claude-code-hook.js` gets the rules automatically — even without a per-project `.claude/settings.json` entry.

To set up global dispatch:
```bash
mkdir -p ~/.webpieces/ai-hooks
# Copy global-dispatch.js to ~/.webpieces/ai-hooks/global-dispatch.js
# Then add to ~/.claude/settings.json:
```

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Write|Edit|MultiEdit|Bash",
        "hooks": [{ "type": "command", "command": "node /Users/YOUR_USER/.webpieces/ai-hooks/global-dispatch.js" }]
      }
    ]
  }
}
```

The dispatch automatically skips projects that already have `claude-code-hook.js` in their `.claude/settings.json` to avoid double-firing.
