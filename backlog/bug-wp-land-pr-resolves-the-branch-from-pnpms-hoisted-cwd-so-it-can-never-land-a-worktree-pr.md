# BUG: `wp-land-pr` resolves the branch from pnpm's **hoisted** cwd, so it can never land a PR whose branch lives in an agent worktree

**Package:** `@webpieces/pr-gate` (plus one field needed in `@webpieces/rules-config`)
**Version seen:** `0.4.700` (as pinned by monorepo-nx; observed 2026-08-31)
**Severity:** High — there is **no working invocation** of `wp-land-pr` for a worktree PR, which is
*every* `/full-cycle` run. A human clicked Merge in the GitHub UI instead, which is precisely the
outcome this command exists to prevent: the UI cannot set the squash subject to `<title> (#N)` and
cannot archive the pre-squash tip.

**Source:**
- `packages/tooling/pr-gate/src/scripts/commands/land-pr-command.ts:64-65` — the whole defect:
  ```ts
  const repoRoot = this.repoRootFinder.resolveRepoRoot(process.cwd());
  const base = this.branchNaming.baseBranchName(
      execSync('git branch --show-current', { encoding: 'utf8' }).trim());
  ```
  `execSync` is given **no `cwd` option**, so it inherits the process cwd.
- `packages/tooling/pr-gate/src/scripts/workflow/landed-worktree-reaper.ts:91-96` — `plan()` is
  cwd-anchored too: it takes `here` (the worktree the process stands in) and returns `null` unless
  `here.branch === landedBranch`. Same input, so the same wrong answer.
- `packages/tooling/rules-config/src/worktrees.ts` — `Worktree` carries `path`, `branch`, `isMain`,
  `prunable`, `locked`, `lockReason`. **It does not carry the worktree's HEAD sha**, which is the
  field the fix below needs.
- `INIT_CWD` is referenced **nowhere** in `packages/` (grepped, zero hits).

## What happens

`pnpm` walks up to the workspace root before executing a bin. A Claude Code agent worktree lives at
`<primary-clone>/.claude/worktrees/agent-<id>` — i.e. *inside* the primary clone — so pnpm walks
straight past the worktree root and executes in the primary clone. `git branch --show-current` then
answers `main`, and `readPr('main')` finds nothing:

```
$ cd .claude/worktrees/agent-a0bad0ae1b32f220c && pnpm wp-land-pr
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
❌ No open PR found for this branch
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

No open PR has head branch "main". Nothing to land.
```

The branch was `dean/one-2800-webpieces-runtime-0-4-704`, with open PR
[monorepo-nx #1087](https://github.com/mealco-internal/monorepo-nx/pull/1087). It is not "no PR" —
it is the wrong branch name, reported as a missing PR.

**And there is no second way in.** Running it from the primary clone requires checking that branch
out there, which git refuses: the branch is checked out in the (harness-locked) worktree. So both
trees fail, for different reasons.

## Why this is a regression against the command's own design

`LandedWorktreeReaper` exists *specifically* so that landing from a linked worktree hands the reap to
a child process rooted in the primary clone instead of deleting its own working directory (#512). The
whole mechanism is unreachable, because the command never gets far enough to learn it is in a
worktree — `plan()` sees the primary clone, `here.isMain` is true, and it returns `null`. The
operator gets `Next: pnpm wp-cleanup` and no reap.

---

# The ask: **any** agent must be able to land it, not just the one that built it

This is the part worth designing rather than patching. Fixing the cwd alone restores the
`/full-cycle` case, but it leaves the common one broken:

> Most of the time the `/full-cycle` subagent lands its own PR. **Many times it does not** — CI was
> still running when the subagent finished, the subagent hit an error, or a coordinator picks the
> work up an hour later. By then that agent is **long gone**, and its worktree is a directory nobody
> is standing in.

So `wp-land-pr` must be runnable from the primary clone, or from an unrelated worktree, and still do
the *complete* job — merge **and** the tree-scoped bookkeeping, against the right tree.

That needs two things: a way to **name** the PR, and a way to **find the tree that holds it, exactly**.

### 1. Naming the PR — `--pr <n>` becomes necessary here

Today the command takes no arguments and infers the PR from the current branch. That is right for the
worker and useless for a coordinator standing on `main`. Add `--pr <n>` (and keep the zero-arg form
as the shorthand for "this branch's PR").

*A note on an earlier objection:* `--pr` alone looked wrong, because the merge is PR-scoped while the
bookkeeping is tree-scoped — a `--pr` run from the wrong tree would merge and then decline all
bookkeeping, leaving exactly the corpse worktree #512 removed. **That objection dissolves once §2
exists.** With exact tree resolution, `--pr` stops meaning "merge blind from wherever I am" and starts
meaning "find that PR's tree and finish the job properly." Both parts are needed; neither is
sufficient.

### 2. Mapping a PR back to its local worktree/branch — **exactly**

The authoritative pairing is `(headRefName, headRefOid)`, and `readPr()` already fetches both.
Everything needed locally is in `git worktree list --porcelain`, which is readable from *any* tree in
the repo — the worktree list lives in the common dir, so a coordinator on `main` sees every agent
worktree without knowing where any of them are.

```
gh pr view <n> --json headRefName,headRefOid     →  branch name + the exact commit GitHub squashed
git worktree list --porcelain                    →  every (path, branch, HEAD sha) in this repo
```

Match on **branch name AND sha**. Name alone is not enough — a second clone or a stale worktree can
hold the same branch name at a different commit, which is the wrong-objects-under-the-right-name
failure `bookkeeping()` already guards against with its `headRefOid` comparison. This is the same
check, moved earlier so it can *select* a tree instead of only vetoing the one you happen to be in.

**Required change in `rules-config`:** `Worktree` must carry the HEAD sha. `git worktree list
--porcelain` already emits a `HEAD <sha>` line per record and the parser currently drops it — so this
is reading a field that is already on the wire, not a new git call.

### 3. Resolution outcomes — and the guarantee that it deletes the tree it landed

| Local state | Merge | Bookkeeping (archive + merge-info + reap) |
|---|---|---|
| A worktree holds `headRefName` **at** `headRefOid` | yes | yes — reap **that** worktree, by resolved path |
| A worktree holds `headRefName` at a **different** sha | yes | **skip, loudly** — print both shas (today's `notTheLandedTipNotice`) |
| No worktree; the branch exists in the primary clone at `headRefOid` | yes | archive + delete branch; no worktree to reap |
| Branch not found locally at all | yes | skip, loudly — "landed from a tree that does not hold it" |

The guarantee Dean asked for — *"is there a way to make sure it deletes the one it is landing?"* —
comes out of that first row: the reap target is not "the worktree I am standing in" and not "a
worktree whose branch name matches", but **the worktree whose HEAD is the exact commit GitHub just
squashed**. `reap-worktree-command.ts` already re-verifies the branch before removing
(`target.branch !== request.branch` ⇒ refuse); it should re-verify the **sha** the same way, so the
child independently confirms the parent's choice rather than trusting an argv path. Nothing is
removed on a name match alone, in either process.

### 4. On `.webpieces/**` as the source of truth — **don't**

The obvious alternative is a sidecar: have `wp-finish-upsert-pr` record
`{ pr, branch, worktreePath, headRefOid }` under `.webpieces/merge-info/staged/<feature>/` and have
landing read it back. **This repo already decided against that, and the reasoning still holds** —
`decisions/0005-the-pr-description-is-the-merge-body.md` deleted the machine-global receipt store
because it was "a cache of a fact the remote already owns, which could only ever be missing, stale,
or on the wrong computer." A worktree path is *more* volatile than a commit body, not less: the
directory gets moved, reaped, or recreated under a new agent id between finish and land.

`(headRefOid, git worktree list)` is a pair of **facts**, needs no stored state, works from a fresh
clone, and is already half-implemented in `bookkeeping()`. Use `.webpieces/merge-info/staged/<feature>/`
as an optional *hint* to make an error message better if you like — never as the thing that decides
what gets deleted.

---

## Suggested fix, smallest first

1. **`land-pr-command.ts:64-65`** — resolve the invocation directory, not the hoisted one:
   `const cwd = process.env['INIT_CWD'] ?? process.cwd();` and pass it to *both*
   `resolveRepoRoot(cwd)` and `execSync(..., { cwd })`. Same in
   `landed-worktree-reaper.ts:91` (`plan()` must be told the cwd, not read it). This alone restores
   the `/full-cycle` case.
2. **`worktrees.ts`** — parse and expose the `HEAD <sha>` line already present in
   `git worktree list --porcelain`.
3. **`--pr <n>`** on `wp-land-pr`, plus §2/§3 resolution, so a coordinator can land a dead agent's PR.
4. **`reap-worktree-command.ts`** — verify the target worktree's HEAD sha as well as its branch.

A regression test worth pinning: run the command from `<primary>/.claude/worktrees/x` via pnpm and
assert it reads `x`'s branch, not the primary clone's. The nesting is what makes this specific to
agent worktrees — a worktree *outside* the clone would not hoist past its own root, which is likely
why this was never caught.

## Field notes

- **The worktree could not be reaped afterwards either.** `pnpm wp-cleanup` from the primary clone
  correctly spared it: `locked by claude agent agent-a0bad0ae1b32f220c, pid 49909 still running`. So
  in practice the reap window opens only after the agent process exits — consistent with the
  structural note on
  [`bug-land-pr-announces-a-reap-the-child-refused-because-it-reads-only-the-exit-code`](./bug-land-pr-announces-a-reap-the-child-refused-because-it-reads-only-the-exit-code.md):
  *"an agent can never reap its own worktree… worktree reaping belongs to the coordinator."* That is
  another argument for the coordinator-runnable `--pr` form: the coordinator is the only actor for
  whom both the lock and the cwd are right.
- **Not a webpieces bug, but it shaped the transcript:** the first two attempts never reached the
  code at all — Claude Code's own permission classifier denied `pnpm wp-land-pr` outright
  ("Blocked by classifier"), including `cd <worktree> && pnpm wp-land-pr` as one compound command.
  It also denied `pnpm wp-checkout-clean-main`, which is the cure the `stale-main-bash-guard` message
  itself prescribes — so the guard prescribed a remedy the harness refused to run. Fixed on the
  consuming side with a Bash allow rule; recorded here only so the transcript reads correctly.
- **Possible guard-UX follow-up (separate report if wanted):** on a clean `main` in the primary
  clone, `stale-main-bash-guard`'s headline cure is
  `git fetch origin main && git checkout -b <new-branch> origin/main`, while the far simpler
  `git pull` sits buried in Fix Option 3's allowlist prose. An agent on a clean main takes the
  headline and creates a pointless branch. The headline should be `git pull` when the tree is the
  primary clone, already on main, and clean.

---

# ✅ DONE — companion change: renamed `wp-checkout-clean-main` → **`wp-sync-main`**

**Decided by Dean: the new name is `wp-sync-main`, and the rename is HARD.** Shipped as a single
diff — the bin, the command class (`SyncMainCommand`), every guard cure string, every L2 matrix row,
the shipped `webpieces.branch-state-matrix.md` template, `CLAUDE.md`, and the specs that pin the
strings all moved together.

It was a separate, smaller change from the cwd bug above, and it was made **because the name was
untrue**, not to game a classifier. The rest of this section is kept as the record of why.

## Why

`wp-checkout-clean-main` pulled main and reaps dead branches. The name says "checkout", "clean" and
"main" in one breath, which reads as *a destructive git operation on the trunk* — something that
throws away your working tree. It does not do that. The name overstates the blast radius, and it
misleads **humans** first; the classifier reaction below is a symptom of the same mismatch, not the
reason to fix it.

`wp-sync-main` says exactly what it does.

## The evidence that made it visible

Observed 2026-08-31, in one monorepo-nx session, against Claude Code's auto-mode permission
classifier:

| Command | Result |
|---|---|
| `cd <worktree> && pnpm wp-land-pr 2>&1 \| tail -40` | **denied** |
| `pnpm wp-land-pr 2>&1 \| tail -40` (bare, primary clone) | ran |
| `pnpm wp-land-pr 2>&1 \| tail -40` (bare, cwd = worktree) | ran |
| `pnpm wp-checkout-clean-main 2>&1 \| tail -30` | **denied** |
| `pnpm wp-cleanup 2>&1 \| tail -50` | ran (and deleted three branches) |

Two separate triggers, and neither is what you would guess:

- **`wp-land-pr` was never denied for its name** — it ran twice, bare. Its single denial was in the
  `cd <other-dir> && …` compound form, i.e. the classifier reacted to the directory hop, not the
  payload. (Worth noting alongside this repo's own
  [`bug-bash-guards-judge-the-shell-cwd-not-the-paths-the-command-touches`](./bug-bash-guards-judge-the-shell-cwd-not-the-paths-the-command-touches.md)
  — two independent systems both twitchy about `cd`.)
- **`wp-checkout-clean-main` was denied bare**, while `wp-cleanup` — genuinely more destructive —
  ran. That difference is the name.

**This is why a `wp-ai-safe-*` prefix was considered and rejected.** It would not have fixed the
`wp-land-pr` denial (the name was never the problem there), asserting safety in a command name is a
shape a classifier may weight *against* you, and it tunes against undocumented behaviour that moves
between releases. The correct remedy for the permission side is an explicit allowlist rule on the
consuming side (`"Bash(pnpm wp-*:*)"`), which is deterministic and auditable. The rename stands on
its own merits.

## ⚠️ Scope: the name is in **133 places across 34 files** — the rename is not the hard part

Measured with `grep -ro "wp-checkout-clean-main"` (excluding `node_modules`/`.git`); by the time the
rename landed it had grown to 146 occurrences across 37 files. **Every prose
reference, guard cure string, matrix row and generated doc must move with it**, because the guards'
whole value is that the cure they print can be pasted and run. A stale cure string is worse than no
cure: it names a command that does not exist, on the one path where the agent is already blocked and
cannot explore.

The reference sites, by kind:

**The command itself**
- `packages/tooling/pr-gate/src/scripts/wp-sync-main.ts` (file rename)
- `packages/tooling/pr-gate/src/scripts/commands/sync-main-command.ts` (file rename; the class became
  `SyncMainCommand`)
- `packages/tooling/pr-gate/src/scripts/commands/main-checkout.ts`, `working-tree-gate.ts`,
  `pr-gate-app.ts`
- `packages/tooling/pr-gate/package.json` — the `bin` entry

**Guard cure strings — the load-bearing ones.** These are the sentences an agent is handed at the
moment every other route is closed:
- `stale-main-bash-guard.ts`, `stale-main-message.ts`
- `merged-branch-bash-guard.ts`, `merged-branch-message.ts`
- `feature-branch-guard.ts`, `read-stale-guard.ts`
- `branch-switch-scan.ts`, `tree-recovery.ts`, `redirect-how-to-merge-main.ts`
- `cure-prefix-scan.ts` — **note:** this appears to validate cure prefixes, so it likely needs the
  new name to keep passing rather than merely mentioning the old one.

**The L0 layer — and a correction to what this document originally assumed:**
- `packages/tooling/ai-hook-rules/src/bin/l0-allowlist.ts` — this document assumed the command was on
  the L0 allowlist and would be "denied by webpieces' own guard" if the new name were not added.
  **It was never on that list, and it must not be.** The allowlist names it only in prose, under the
  heading *"WHY L0 KEEPS THE RAW GIT WHILE THE WORKFLOW LAYER MOVED TO `pnpm wp-sync-main`"*: the
  fault L0 cures is `node_modules` disagreeing with the pin, so `node_modules` is precisely what
  cannot be trusted, and **a cure that resolves through `node_modules` is the one class of cure that
  may not appear on an L0 allowlist.** L0 keeps the raw `git checkout main && git pull origin main`
  (`CHECKOUT_MAIN_PULL_CMD`) for that reason. The rename therefore changed the prose here and nothing
  else — adding `wp-sync-main` as an L0 entry would have deleted that invariant, not preserved it.
- `packages/tooling/ai-hook-rules/src/core/l0-matrix.ts`, `l2-rows.ts`, `l2-doc.ts`
- `packages/tooling/ai-hook-rules/src/bin/shim-drift-fix.ts`

**Docs and generated matrices** (these are what land in consuming repos as
`.webpieces/instruct-ai/webpieces.branch-state-matrix.md`, so a stale one ships outward):
- `packages/tooling/rules-config/templates/webpieces.branch-state-matrix.md`
- `guards/L2-branch-state.md`
- `CLAUDE.md`
- `packages/tooling/rules-config/src/home-config.ts`
- `docs/audit/2026-08-20-0500-0937.md`, `docs/audit/2026-08-24-mon-wed.md` (historical records —
  leave these alone, or annotate; do not rewrite history)

**Specs that pin the strings:** `l2-matrix.spec.ts`, `cure-prefix-scan.spec.ts`,
`pr-merge-guard.spec.ts`, `read-stale-guard.spec.ts`, `redirect-how-to-merge-main.spec.ts`,
`stale-main-bash-guard.spec.ts`, `tree-recovery.spec.ts`.

## ❌ The "deprecated alias for one or two releases" suggestion was REJECTED

This document originally proposed keeping `wp-checkout-clean-main` as a delegating alias that printed
`use wp-sync-main`, on the grounds that consuming repos have the old name in their own committed docs
and update on their own timetable.

**Dean rejected it, and the repo's own policy already did.** An alias is shim shape #1 (two spellings
of one thing) and shape #2 (`@deprecated` in place of deletion) under CLAUDE.md § "NO webpieces
surface is released backwards-compatible", and `backwards-compat-reviewer` — a REQUIRED checklist —
blocks it. There is exactly ONE spelling after this change: the old bin, the old file names and the
old class name are gone. A consuming repo that still says `wp-checkout-clean-main` gets a
`command not found`, and that error IS the delivery mechanism for the migration, not a cost of it.

The grep-in-CI half of the suggestion DID ship: `no-old-sync-main-name.spec.ts` (ai-hook-rules) walks
every tracked file and fails if `wp-checkout-clean-main`, `CheckoutCleanMainCommand`,
`checkoutCleanMainCommand` or `checkout-clean-main-command` appears anywhere outside `docs/audit/**`
(historical records, deliberately left naming the old command) and this backlog file. That is what
stops a future agent reintroducing the old name in a new cure string.

## Related guard-UX defect, same file, worth fixing in the same pass

On a **clean `main` in the primary clone**, `stale-main-bash-guard`'s headline cure is
`git fetch origin main && git checkout -b <new-branch> origin/main`, while the far simpler `git pull`
sits buried in Fix Option 3's allowlist prose. Observed live: an agent took the headline and created
a pointless throwaway branch, when `git checkout main && git pull --ff-only` cleared the block in one
command. When the tree is the primary clone, already on `main`, and clean, the headline should be
`git pull` (or `pnpm wp-sync-main`) — branch creation is the cure for a *different* row.
