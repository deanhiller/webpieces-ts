# BUG: read-stale-guard blocks the Read tool on stale `main` but has NO Bash counterpart — content-reading Bash (`cat`/`grep`/`ls`) reasons over stale files for a whole session

**Package:** `@webpieces/ai-hook-rules` / `@webpieces/nx-webpieces-rules` (the PreToolUse guard chain;
rule at `packages/tooling/ai-hook-rules/src/core/rules/read-stale-guard.ts`)
**Version seen (consuming repo):** installed `@webpieces/nx-webpieces-rules` **`0.4.452`** (guard source
read from `/Users/deanhiller/workspace/personal/webpieces-ts40` @ `main`)
**Reporter context:** hit live on **2026-07-28→29** in a consuming monorepo
(`/Users/deanhiller/workspace/onetablet/monorepo-nx1`). An assistant (Claude Code, Opus 4.8) finished a
task, ran `pnpm wp-cleanup`, `git checkout main`, and then **local `main` never got updated** (`git pull
origin main` was failing with `fatal: Cannot fast-forward to multiple branches`, a separate FETCH_HEAD
quirk). It then spent the rest of the session running `grep` / `ls` / `cat` / `git log -- <path>` over
the working tree — **18 commits behind origin/main** — and drew confident conclusions about the repo's
CI/deploy workflows from files that no longer match upstream. **Every one of those Bash reads was
allowed.** The `read-stale-guard` was live and correctly blocks the *Read tool* in exactly this state,
but it never looks at Bash, so all the stale reading went through a side door.
**Severity:** Medium–High — this is the READ half of the protection failing open, and the guard's own
class comment says the read is *the* place to block precisely because "blocking the write is too late —
the bad premise is already in context." Content-reading Bash puts the bad premise in context just the
same, unguarded.

## This is the State-A twin of the already-filed State-B bug

`backlog/bug-merged-branch-guard-fails-open-on-bash-lets-a-whole-session-run-on-a-merged-branch.md`
reported the **merged-branch** (State B) version of this hole and it was fixed by adding
`MergedBranchBashGuardRule` (`merged-branch-bash-guard.ts`), which blocks ordinary Bash on a merged
branch while allowlisting recovery/inspection commands.

`read-stale-guard.ts` documents **two** states it protects on the Read path:
- **State A** — on `main`, local main BEHIND origin/main (`checkStaleMain`)
- **State B** — on a feature branch whose PR is already merged (`checkMergedBranch`)

But `MergedBranchBashGuardRule` only covers **State B**. Its guard body short-circuits on State A:

```
// merged-branch-bash-guard.ts (~line 91)
if (!status.branchAlreadyMerged) return this.allow(ctx, branch, 'clean-feature-branch', cache);
```

On stale `main`, `branchAlreadyMerged === false`, so the Bash guard **allows everything**. There is no
`StaleMainBashGuardRule`. **State A has a Read-tool block and no Bash counterpart at all.**

## The design choice that created the hole (and why it's now half-right)

`read-stale-guard.ts`, class comment, is explicit and deliberate:

> **WHY THIS CANNOT WEDGE: the block is scoped to Read ONLY.** Every cure — `git pull origin main`,
> `pnpm install`, any webpieces upgrade — is a Bash command, and this guard never looks at Bash. So
> there is no command allowlist to maintain and no way to lock the agent out of its own fix.

That reasoning is sound for the *cure* commands — you must never block `git pull` / installs. But it
throws out the baby with the bathwater: **content-reading Bash** (`cat`, `grep`, `ls`, `head`, `tail`,
`sed`, `awk`, `less`, `git show <rev>:<path>`) is not a cure and not git metadata — it is the exact
"stale FILE content" the guard exists to keep out of context. The merged-branch guard already draws this
line correctly for State B (its comment: *"Reading git METADATA (log/diff/show) is fine — it is not the
stale FILE content"*) and allowlists cures + read-only git while blocking `cat`/`grep` of tracked files.
State A just never got the same treatment.

## Evidence (live, this session — consuming repo `monorepo-nx1`)

`.webpieces/main-sync-status.json` — pure State A (on main, behind, NOT a merged branch):

```json
{ "branch": "main", "branchAlreadyMerged": false, "mergedPr": "",
  "localMain": "779230ccea6e14546325a19d35d9221976c57dd9",
  "originMain": "4d9e8bd274a85a3c19d12cc2ff910eaf79bf728c", "conflict": false }
```

How stale that is, and that I reasoned over changed files:

```
$ git rev-list --left-right --count HEAD...origin/main
0    18                       # 18 commits behind

$ git diff --stat 779230c origin/main | tail -1
108 files changed, 8069 insertions(+), 3692 deletions(-)

$ git diff --stat 779230c origin/main -- .github/workflows/
 .github/workflows/kami-migration-check.yml | 186 +++++++++++++++++++++++++++++   # NEW upstream
 .github/workflows/promote-to-prod.yml      |   6 +                                 # CHANGED upstream
```

Concrete wrong outputs I produced from stale Bash reads (no guard fired on any of them):
- `ls .github/workflows/` returned a list **missing `kami-migration-check.yml`** (186-line workflow that
  exists on origin/main but not in my tree) — I then discussed "the workflow set" from that incomplete list.
- `grep`/`cat` over `.github/workflows/deploy-tf-services.yml` + `promote-to-prod.yml` to describe the
  dev→prod deploy flow — `promote-to-prod.yml` had changed upstream (+6), so I was quoting an old copy.
- `git log --oneline origin/main | grep '#731|#733'` etc. were fine (origin/* metadata, current) — the
  problem is exclusively the **working-tree content** reads.

Guard logs confirm the asymmetry — `read-stale-guard` decisions exist **only** for Read/Write/Edit,
never for Bash, because the guard is never invoked on the Bash path:

```
.webpieces/hooks/guard-sync-decisions.*.log   → rows are all tool=Read|Edit|Write for read-stale-guard
.webpieces/hooks/guard-invocations.log        → Bash calls are logged with sync status but no read-stale decision
```

So, exactly as in the State-B bug: the status is computed and logged on the Bash path, but no
block decision consumes it for State A.

## Why it matters

The guard's entire rationale (class comment) is that reading stale content poisons the plan before any
write happens, so the block must land on the *read*. Scoping that block to the Read tool only means the
protection is trivially bypassed by `cat`/`grep`/`ls` — which is how an assistant naturally inspects a
repo. The logs then read as "read-stale-guard handled" while a whole session's analysis was built on an
18-commit-stale tree. That is worse than no guard, because it looks handled.

## Repro (deterministic)

```
git checkout main
git reset --hard origin/main~18        # simulate a local main 18 behind (or just let it drift)
# do NOT pull. main-sync-status.json now shows localMain != originMain, branchAlreadyMerged:false
#   Read tool  →  BLOCKED by read-stale-guard ("on main and main is N behind origin/main")
cat  .github/workflows/promote-to-prod.yml    # ← ALLOWED — returns the STALE file
grep -r foo services/                         # ← ALLOWED — greps the STALE tree
ls   .github/workflows/                        # ← ALLOWED — lists the STALE dir (misses new files)
# .webpieces/hooks/guard-sync-decisions.log has NO Bash rows for read-stale-guard
```

## Suggested fix direction

Add the State-A Bash counterpart, mirroring `MergedBranchBashGuardRule` (which already solved State B):

- **New `StaleMainBashGuardRule`** (or extend the existing Bash guard to also handle `status.branch ===
  'main' && localMain is behind originMain && !dirty`). When on stale `main`, **block content-reading
  Bash on tracked files** and redirect to the same cure as the Read block: `git pull origin main`.
- **Allowlist the cure and orientation commands** so it can never wedge (this is the crux — the user
  called it out explicitly): `git pull origin main`, `git fetch`, `pnpm/npm/yarn install`, any
  `pnpm wp-*` / webpieces upgrade, all read-only git metadata (`git status|log|diff|show|branch|
  rev-list|merge-base`), and `gh` reads. Reuse the exact allowlist machinery in
  `merged-branch-bash-guard.ts` (recovery/inspection segment matcher) — it already encodes this.
- **Preserve the two fail-open escape valves** from `read-stale-guard`'s `checkStaleMain`: dirty tree →
  allow (pull is not a guaranteed fast-forward; don't trap the agent), and `local-main-contains-origin`
  (ancestry, not equality) → allow the instant the pull lands.
- **Scope to content readers only**, not all Bash: block `cat|grep|rg|head|tail|sed|awk|less|more|
  git show <rev>:<path>` targeting workspace files; leave everything else (builds, tests, the cure) alone.
  Blocking git *metadata* is wrong — only stale *file content* is the hazard.

Net effect: on stale `main`, the assistant is pushed to `git pull origin main` before it can `cat`/`grep`
the tree — closing the same door on the Read side that `merged-branch-bash-guard` closed on the merged
side, without ever blocking the pull/install that fixes it.

## Also worth noting (separate, minor)

`git pull origin main` intermittently fails with `fatal: Cannot fast-forward to multiple branches` in
this checkout (multiple `for-merge` entries in FETCH_HEAD), which is *why* main sat stale for the whole
session. Not this guard's bug, but it's the trigger that keeps a repo parked in State A, so the Bash
guard above is what would have caught the consequence. A `git pull --ff-only origin main` in the guard's
suggested-cure text (instead of bare `git pull origin main`) would sidestep that specific failure.
