# L2 — branch state

**Goal: may I work here, and is what I read current?**

**Config key: `branch-state-guard` (proposed).** Today this one policy is spread across FOUR keys —
`feature-branch-guard`, `read-stale-guard`, `stale-main-bash-guard`, `merged-branch-bash-guard`. Three
of them carry nothing but `mode` plus the two escape hatches.

**Code:** `ai-hook-rules/src/core/rules/{feature-branch,read-stale,stale-main-bash,merged-branch-bash}-guard.ts` ·
the shared cache in `rules-config/src/main-sync-status.ts` + `main-sync-file.ts` ·
the refresher in `ai-hook-rules/src/core/sync-main.ts`.

---

# Part 1 — AS-IS

## The four guards

| | Write/Edit | Read | Bash |
|---|---|---|---|
| **state A** — stale `main` | `feature-branch-guard` | `read-stale-guard` | `stale-main-bash-guard` |
| **state B** — merged branch | `feature-branch-guard` | `read-stale-guard` | `merged-branch-bash-guard` |

All four implement **never block on data you could not establish** via three identical checks, written
four times with four different reason strings:

```
currentBranch() === null      → allow "branch-undeterminable (fail-open)"
status === null               → allow "no-sync-cache (fail-open)"
status.branch !== branch      → allow "stale-cross-branch-cache (fail-open)"
```

## The cache

`<primary clone>/.webpieces/main-sync-status.json`, written by a **detached single-flight refresher**.
It is fire-and-forget: it populates the cache for the NEXT call, never the current one — so the first
tool call of every session sees no cache and fails open. That is intended, and it is why the on-main
write block must not depend on the cache.

Since the branch-keying change the file holds a **map of branch → status**, so every worktree's guards
stay armed. Before that it held one branch's snapshot, so with N worktrees at most one tree was armed at
any instant and the rest abstained, thrashing as the lock changed hands.

**There is no TTL.** `timestamp` is logged and never enforced; an hours-old cache whose branch matches is
trusted to block. State A is mitigated by a live ancestry check (below); state B trusts the cached merged
flag, which is safe only because "merged" is monotonic.

## The as-is table

| # | tool | HEAD | cache | evidence | dirty | scope | act | why |
|---|---|---|---|---|---|---|---|---|
| 1 | - | - | - | - | - | out | 2 | exempt — never judged |
| 2 | - | `?` | - | - | - | in | 3 | branch undeterminable |
| 3 | `W` | `main` | - | - | - | in | 4 | **write on main — before the cache is read** |
| 4 | - | - | none | - | - | in | 3 | no cache |
| 5 | - | - | other | - | - | in | 3 | cache for another branch (now defensive only) |
| 6 | `R`/`B` | `main` | ok | origin unknown | - | in | 3 | offline |
| 7 | `R`/`B` | `main` | ok | current | - | in | 1 | main is current |
| 8 | `R` | `main` | ok | stale | dirty | in | 3 | stale main, dirty |
| 9 | `R` | `main` | ok | stale | clean | in | 4 | stale main read |
| 10 | `B` | `main` | ok | stale | dirty | in | 3 | stale main, dirty |
| 11 | `B` | `main` | ok | stale | clean | in | 4 | stale-main content read |
| 12 | `R` | feature | ok | merged | dirty | in | 3 | merged, dirty |
| 13 | `R` | feature | ok | merged | clean | in | 4 | merged branch read |
| 14 | `B` | feature | ok | merged | - | in | 4 | merged — **dirty ignored** |
| 15 | `W` | feature | ok | merged/no-fork/conflict | - | in | 4 | unhealthy branch |
| 16 | - | feature | ok | clean | - | in | 1 | healthy feature branch |

**Row 3 breaks the model.** It fires before `readMainSyncStatus` is ever called, so it sits ABOVE rows
4–5. It is not sync state — it is **branch policy**: never edit on main, regardless of anything.

## The dirty-tree split

| state | Read | Bash | Write |
|---|---|---|---|
| stale main, dirty | ALLOW | ALLOW | **BLOCK** |
| merged branch, dirty | **ALLOW** | **BLOCK** | BLOCK |

Row 2 is the incoherence: read a file, yes; `cat` the same file, no. Same information, opposite verdicts,
because two authors wrote two ladders. `read-stale-guard`'s own class comment still claims state B
"blocks ANYWAY" on a dirty tree while its code allows — this call was already flip-flopped once.

## Deliberate divergence — do NOT unify

The two Bash guards differ on **three orthogonal axes at once**:

| axis | Bash + merged | Bash + stale main |
|---|---|---|
| polarity | default-**DENY** + allowlist | default-**ALLOW** + blocklist |
| quantifier | `every` segment must pass | `some` segment triggers |
| empty command | denies | allows |

Not De Morgan duals: `pnpm build` is denied by one and allowed by the other; `git grep foo` is denied by
both for different reasons. No single parameterised function serves both.

Also deliberate: `contains()` uses `spawnSync` so "git could not answer" stays distinguishable from "not
an ancestor" and is treated as contained (allow). `isDirty()` catches and returns true because dirty is
the fail-OPEN direction. Flipping either turns an allow into a block.

## Drift — should be shared

1. `currentBranch()` in 4 copies; only `read-stale-guard` has the `.git/HEAD` fast path — applied to the
   guard that runs on every Read but NOT to the Bash guards that run on every command.
2. `isDirty()` and `contains()` duplicated verbatim between two guards.
3. `behindCount()` duplicated verbatim.
4. `cacheSummary()` in **four different shapes**, so correlating one decision across guards is harder
   than it should be.
5. `allow` / `block` / `logDecision` / `truncate` are four copies.
6. `read-stale-guard` is INCLUDED in the Read path by an include-list but nothing EXCLUDES it from the
   file-tool path, so it also runs on Write/Edit despite claiming "Read ONLY". Behaviourally inert —
   `feature-branch-guard`'s block set is a strict superset on every file-tool state — so scoping it
   properly is a provable no-op. Untested today.
7. Refresh-trigger position differs: `feature-branch-guard` tests `branch === 'main'` BEFORE triggering
   the refresh; the others trigger first. A session on `main` doing only Writes never warms the cache.

## Incidents these guards exist because of

- **The 157-commit checkout.** An agent ran `git checkout main` in a clone whose local `main` was 157
  commits behind. That checkout reverted the `@webpieces` pin, reverted `.claude/webpieces/ai-hook.sh`
  — **the drift guard itself** — to a copy whose message stated the drift backwards, and so reverted the
  agent's judgment: it ran the `pnpm install` that message named and downgraded `node_modules`. Lesson,
  quoted from the code: *a guard a stale checkout can revert cannot be relied on to catch a stale
  checkout.* Hence `bareCheckoutOfMain`, which is preventive, matches on command TEXT only, and asks git
  nothing — deliberately, because the only `main` it could measure is the one it is about to leave.
- **The side door.** An agent on a `main` 18 commits behind (108 files, +8069/−3692 upstream) had its
  Read tool blocked exactly as designed, then spent the session `ls`-ing, `grep`-ing and `cat`-ing the
  same stale tree, and described a CI workflow set missing a 186-line workflow that existed upstream.
  *The logs read "read-stale-guard handled", which is worse than no guard: it looks covered.*
- **Computed and thrown away.** Both file guards are file-scoped, so Bash reached neither. An agent that
  only ran shell sailed through on a merged branch **even though `branchAlreadyMerged` was loaded and
  logged on that very path.**

---

# Part 2 — PROPOSED

## Two policies, not one

The four guards look inconsistent because they answer two different questions. Separating them is the
whole simplification.

- **WRITE policy** — *where will my commits land?* Only on a healthy feature branch.
- **READ policy** — *is this content current?* Only if the tree is not a stale snapshot.

The split is already latent in the code: `read-stale-guard` ignores `hasForkPoint` and `conflict`
entirely, because those are write concerns and say nothing about staleness.

## Table A — WRITE / MUTATE

Write, Edit, and mutating Bash — **including `git commit` and `git add`**. Committing is *working here*.

| # | state | cache | verdict | cure |
|---|---|---|---|---|
| A0 | merge in progress | — | **EXEMPT** | finish the merge — L4 owns this state |
| A1 | on `main` | **not needed** | BLOCK | branch off `origin/main` |
| A2 | cache absent, or for another branch | — | ALLOW *(fail open)* | — |
| A3 | on a merged branch | needed | BLOCK | branch off `origin/main` |
| A4 | no fork point, or `main` collided with your files | needed | BLOCK | `pnpm wp-start-update`, or `pnpm wp-start-upsert-pr` when a PR is open |
| A5 | healthy feature branch | needed | ALLOW | — |

**A1 sits above A2 and that ordering is load-bearing.** The on-main block is cache-free, and the cache's
fail-opens must not preempt it. A naively ordered collapse puts `cache-absent` first and permits writes
on `main` on the first tool call of every session — and permanently in a multi-worktree repo.

**A4 is REPAIR, not leave.** `wp-start-update` does the 3-point squash merge and rewrites the branch,
**producing a correct fork point**, so the branch you are standing on becomes healthy. Branching off
would abandon it. `feature-branch-guard` already picks between the two `wp-start-*` commands based on
whether a PR is open.

## Table B — READ / INSPECT

Read, and content-reading Bash — **including `git grep` and `git show <rev>:<path>`**, which read tracked
file content.

| # | state | cache | verdict | cure |
|---|---|---|---|---|
| B0 | merge in progress | — | **EXEMPT** | finish the merge |
| B1 | cache absent, or for another branch | — | ALLOW *(fail open)* | — |
| B2 | on `main`, behind `origin/main` | needed | BLOCK | `git pull`, or branch off `origin/main` |
| B3 | on `main`, **current** | needed | **ALLOW** | — |
| B4 | on a merged branch | needed | BLOCK | branch off `origin/main` |
| B5 | broken fork point / collided | — | ALLOW | — |
| B6 | healthy feature branch | needed | ALLOW | — |

**B3 is deliberate.** Reading a CURRENT `main` is fine — the problem is that `main` is almost always
behind. So staleness stays, for reads only. Writes on `main` block either way (A1), which is exactly why
the two tables must not be merged.

**B5 confirms the split**: a broken fork point blocks writes and says nothing about reads.

## A0/B0 — the merge-in-progress row

While `wp-start-update` is resolving a conflict you must be able to read AND write the conflicted files.
L2 stands down and defers to `merge-in-progress-guard` (L4), which owns that state.

The code already learned this the hard way: that guard's hint used to say "do not run other commands" —
*"an unbounded claim that forbade the reads, the `git add`, the build and the tests that finishing a
merge actually requires."* It now renders its hint from its own blocked lists so the two cannot drift.

Without this row, A4 prescribes a cure that A1–A5 would then block.

## The skip list

The commands L2 never judges. The principle: **these get you OUT or tell you where you are** — they are
not "working here".

**Get out**

| command | why |
|---|---|
| `git checkout -b <new> origin/main` | leave; current by construction |
| `git switch -c <new> origin/main` | same |
| `git switch <other-branch>` | leave |
| `git worktree add … -b <new> origin/main` | leave |

**Make `main` current**

| command | why |
|---|---|
| `git pull` / `git fetch` | the cure for B2 |
| `git checkout main && git pull origin main` | **paired only** — a bare `git checkout main` is blocked, see the 157-commit incident |

**Orient — needed to decide what to do**

| command | why |
|---|---|
| `git status` · `git log` · `git diff` · `git branch` | git METADATA, not file content |
| `gh pr view\|list\|status\|checks` | is my PR merged? |

**Park work so you can leave**

| command | why |
|---|---|
| `git stash` | the only way to carry uncommitted work off a dead branch |

**Repair and tooling**

| command | why |
|---|---|
| `pnpm wp-start-update` · `pnpm wp-start-upsert-pr` | A4's cure |
| `pnpm install`, the `wp-*` bins | fix the tooling |
| read **and** edit `webpieces.config.json` | the mode-OFF hatch |

**NOT on the skip list — this is "working here"**

`git commit` · `git add` · `git push` · `git merge` · `git rebase` · `git reset` · `git restore` ·
`git clean` · `git cherry-pick` · `git grep` · `git show <rev>:<path>` · `git cat-file` · `git ls-files`

The last four read tracked file content, so they fall under table B, not the skip list.

This replaces a hand-maintained 31-entry git allowlist with ~14 entries each justified by "gets you out"
rather than "seemed harmless".

## Cannot tell

Split by whether the state is *expected*:

| state | expected? | treatment |
|---|---|---|
| cache absent | **yes** — the refresher populates for the NEXT call, so this fires on the first tool call of every session | fail open, log |
| detached HEAD | **yes** — mid-rebase, `git checkout <sha>` | fail open, log |
| branch unresolvable | **no** — not a repo, git broken | fail open, log LOUDLY |
| cache for another branch | **no** — unreachable since the cache became branch-keyed | fail open, log LOUDLY |

**Do NOT block to capture cases.** `cache-absent` fires on every session's first call; blocking there
deadlocks every session behind a network fetch. And if a guard cannot establish state, blocking means a
*broken* guard wedges the session — the exact failure this family exists to avoid.

Make `ALLOW_FAIL_OPEN` a **typed verdict** instead of today's string suffix, so abstentions are
countable. Nothing currently reads the decision log; a `wp-*` report over it would have surfaced the
N-worktree cache hole from telemetry rather than from reading comments.

## What changes

| | today | proposed |
|---|---|---|
| Write on `main` | BLOCK | BLOCK |
| Read/Bash on a **current** `main` | ALLOW | ALLOW |
| Read/Bash on a **stale** `main`, clean | BLOCK | BLOCK |
| Read/Bash on a **stale** `main`, **dirty** | ALLOW | **BLOCK** |
| Read on a merged branch, **dirty** | ALLOW | **BLOCK** |
| `cat` on a merged branch, dirty | BLOCK | BLOCK |
| `git commit` on a merged branch | BLOCK | BLOCK |
| healthy feature branch | ALLOW | ALLOW |

**Deleting the dirty valve is the ONLY behaviour change.** Cleanup stays reachable through the skip
list — which is how `merged-branch-bash-guard` already works, and why it alone never calls `isDirty()`.
Note the skip list has `git stash` but not `git commit`, so "tidy up first" means **stash**.

Everything else in the proposal is refactor: four ladders become one classifier plus a verdict table,
with the two Bash scope predicates referenced by name from their cells rather than buried in ladders.

## Config

```json
"branch-state-guard": {
    "mode": "ON",
    "branchNamingConvention": "{whoami}/{featurename}",
    "hangTimeoutMinutes": 5,
    "turnOffRuleUntilEpoch": 0,
    "turnOffRuleWhileOnBranch": null
}
```

Replaces the four keys; `hookGuards` goes 9 → 6 (→ 4 once L3 and L4 collapse too).

The four CLASSES stay — they carry tool wiring and the per-guard decision-log identity operators grep by.
Only the switch merges. **Half a policy is representable today** — you can set `read-stale-guard: OFF`
while `merged-branch-bash-guard` stays `ON`, which is precisely the Read-allows / `cat`-blocks split
documented above. One switch makes that unrepresentable.

**This is a hard cut, not a fallback.** Per `CLAUDE.md`, a moved config key is REJECTED with an error
naming the destination, recorded in `retired-config-keys.ts`, and its read path is deleted in the same
change. Source and config still ship in separate PRs because the running validator is a release behind.

## Staged PRs — never all four guards at once

| PR | change | behaviour change? |
|---|---|---|
| 1 | Golden characterization tests over the CURRENT four guards, generated cell universe. The frozen baseline. | none |
| 2 | Shared probe (`currentBranch` + the `.git/HEAD` fast path); adopt in `read-stale-guard` first — zero delta | none |
| 3 | Typed `ALLOW_FAIL_OPEN`; loud logging for the two anomalous states | log only |
| 4 | Classifier + verdict table as UNREFERENCED code, plus a differential test asserting old ladders and new table agree over the whole universe | none |
| 5 | Switch guards one PR each: `feature-branch` → `read-stale` → `merged-branch-bash` → `stale-main-bash` | none — proven by PR 4 |
| 6 | Formally scope `read-stale-guard` to Read | provable no-op |
| 7 | **THE BEHAVIOUR CHANGE** — delete the dirty valve. Rewrites this file's Part 1 away. | **yes** |
| 8 | Retire the four config keys for `branch-state-guard` (source only) | none |
| 9 | *After publish* — migrate the live `webpieces.config.json` | config only |
| 10 | Abstention report over the decision log | new command |

PRs 1–6 are pure refactor; 7 is the only one that changes what an agent can do, so it reverts alone.

## Tests

**The anti-stuck guarantee, and it must be a test.** L0's cure-reachability test caught a fault
prescribing a bin that had been renamed away. The L2 analogue: **every command named in a block message
must be accepted by the skip list, in the state that block describes.**

- **Totality** — every cell yields exactly one verdict; twice gives the same answer.
- **No implicit default** — every (state, tool) pair has an explicit entry. A missing cell is a test
  failure, never a fallthrough; a fallthrough default is how you get a silent allow.
- **No shadowed row** — each row carries a witness state; assert it classifies there AND wins.
- **Fail-open discipline** — a cannot-tell state always yields ALLOW, with a named exception list.
- **A1 is cache-free** — Write on `main` still BLOCKS with: no cache, cache for another branch, dirty
  tree, and `main` current. Four rows, and the highest-value test in the suite.

## Code anchors

| section | file | symbol |
|---|---|---|
| write policy | `ai-hook-rules/src/core/rules/feature-branch-guard.ts` | `check` |
| read policy | `ai-hook-rules/src/core/rules/read-stale-guard.ts` | `checkStaleMain`, `checkMergedBranch` |
| stale-main Bash | `ai-hook-rules/src/core/rules/stale-main-bash-guard.ts` | `staleContentRead`, `bareCheckoutOfMain` |
| merged-branch Bash | `ai-hook-rules/src/core/rules/merged-branch-bash-guard.ts` | `isFullyRecovery`, `ALLOWED_GIT_SUBCOMMANDS` |
| the cache | `rules-config/src/main-sync-status.ts`, `main-sync-file.ts` | `readMainSyncStatus`, `MainSyncStatusFile` |
| the refresher | `ai-hook-rules/src/core/sync-main.ts` | `refreshMainSync` |
| command scanning | `ai-hook-rules/src/core/rules/content-read-scan.ts`, `shell-segment-scan.ts` | `readsStaleContent`, `classify` |
