# L2 — branch state

**Goal: may I work here, and is what I read current?**

**Config key: `branch-state-guard`.** ONE key for the whole policy. It used to be FOUR —
`feature-branch-guard`, `read-stale-guard`, `stale-main-bash-guard`, `merged-branch-bash-guard` —
and three of them carried nothing but `mode` plus the two escape hatches. Four keys made HALF a
policy representable: `read-stale-guard: OFF` beside `merged-branch-bash-guard: ON` is "read the
file, yes; `cat` the same file, no" — the same information, opposite verdicts, chosen by nobody.
One key makes that unconstructible. The four class NAMES are unchanged and still appear as `rule=`
on every decision-log line, so `grep rule=stale-main-bash-guard` keeps working; only the switch
merged. The four old keys are rejected by name with this destination — see `retired-config-keys.ts`.

**Code:** `ai-hook-rules/src/core/rules/{feature-branch,read-stale,stale-main-bash,merged-branch-bash}-guard.ts` ·
the rows in `ai-hook-rules/src/core/l2-rows.ts` · the shared cache in
`rules-config/src/main-sync-status.ts` + `main-sync-file.ts` · the refresher in
`ai-hook-rules/src/core/sync-main.ts`.

## The four classes, and why there are four

| | Write/Edit | Read | Bash |
|---|---|---|---|
| **state A** — stale `main` | `feature-branch-guard` | `read-stale-guard` | `stale-main-bash-guard` |
| **state B** — merged branch | `feature-branch-guard` | `read-stale-guard` | `merged-branch-bash-guard` |

The split is TOOL WIRING, not policy. A Read names exactly one file; a Bash command is opaque; a
Write is neither. And the two Bash guards are not De Morgan duals — they differ in **polarity**
(merged is default-DENY + allowlist, stale-main is default-ALLOW + blocklist), in **quantifier**
(`every` segment must pass vs `some` segment triggers) and on the **empty command** (denies vs
allows). `pnpm build` is denied by one and allowed by the other. No single parameterised function
serves both, which is why the classes stay four while the switch became one.

## The cache

`<primary clone>/.webpieces/main-sync-status.json`, written by a **detached single-flight
refresher**. It is fire-and-forget: it populates the cache for the NEXT call, never the current
one — so the first tool call of every session sees no cache and takes row 11. That is intended,
and it is why the on-main write block (row 5) must not depend on the cache.

The file holds a **map of branch → status**, so every worktree's guards stay armed. Before that it
held one branch's snapshot, so with N worktrees at most one tree was armed at any instant and the
rest abstained, thrashing as the lock changed hands.

**There is no TTL.** `timestamp` is logged and never enforced; an hours-old cache whose branch
matches is trusted to block. State A is mitigated by a live ancestry check (`git merge-base
--is-ancestor`, not hash equality, so a pull takes effect instantly); state B trusts the cached
merged flag, which is safe only because "merged" is monotonic.

**`hangTimeoutMinutes` is ONE knob** — `branch-state-guard.hangTimeoutMinutes` — because there is
one refresher writing one cache. It used to be declared four times and read four times, which,
with the refresher's at-most-once-per-process latch and two config-blind callers ahead of the
guards, meant at most one of the four values could ever reach a spawn.

## Table — one table, ordered, first match wins

**Tools:** `B` Bash · `R` Read · `E` Write/Edit

| # | tools | state | act | cure |
|---|---|---|---|---|
| 1 | `B R E` | on the **global allowlist** (inert command, or a universal cure such as reading/editing `webpieces.config.json`) | 1 allow | — |
| 2 | `B` | bare `git checkout main`, with no `git pull` chained into the same command | 4 block | `git checkout main && git pull origin main` |
| 3 | `B R E` | **merge in progress** — L4 owns this state | 2 exempt | finish the merge: `pnpm wp-finish-upsert-pr` |
| 4 | `B` | on the **skip list** — it gets you OUT, or tells you where you are | 1 allow | — |
| 5 | `B E` | on `main` | 4 block | `git checkout -b <new> origin/main` |
| 11 | `B R E` | **the state could not be established** — branch undeterminable, no cache yet, the cache holds another branch, `origin/main` unknown, the forge unreachable, or a dirty tree whose cure is not a clean fast-forward | 1 allow (fail-open) | — (nothing to fix; the refresher populates the cache for the next call) |
| 6 | `R` | on `main`, behind `origin/main` | 4 block | `git pull origin main`, or `git checkout -b <new> origin/main` |
| 7 | `R` | on `main`, current | 1 allow | — |
| 8 | `B R E` | on a branch whose PR is **already merged** | 4 block | `git fetch origin main && git checkout -b <new> origin/main` |
| 9 | `B R E` | no fork point with `origin/main`, or `origin/main` moved and collided with your files | 4 block | `pnpm wp-start-update`, or `pnpm wp-start-upsert-pr` when a PR is open |
| 10 | `B R E` | healthy feature branch | 1 allow | — |

Rows 1-5 need **no cache** and fire on call #1: rows 1, 2 and 4 are text matches, row 3 is a
marker-file scan, and row 5 is one `git rev-parse`. Row 11 is the divider: everything below it
reads the main-sync cache, so if the branch is undeterminable, the cache is absent, it holds
another branch, or the forge could not be reached, evaluation STOPS at row 11 and ALLOWS.

Row 11 is numbered after row 10 and PRINTED between 5 and 6, and that is not a mistake. Row
numbers are identity — they are logged as `row=` and cited here — so renumbering 6-10 to slot it in
would silently re-point every reference. L1 does the same with its row 8.

### The one rule that explains the tool column

**`B` tracks `E` everywhere. `R` is judged separately in exactly one place — rows 6/7, on `main`.**

A Read names exactly one file, so the guard can evaluate it precisely. A Bash command is opaque, so
it gets the conservative answer. Reading a CURRENT `main` is fine; the problem is that `main` is
almost always behind.

### Why the order of row 5 is the most load-bearing thing here

L2 is armed **from the second tool call onward**, because the refresher populates the cache for the
NEXT call. That is deliberate — it keeps the blocking path free of network git — and it is fine in
practice, because the agent discovers the problem within a command or two.

Row 5 is the exception that must not be relaxed. Put "on `main`" BELOW row 11 and writes on `main`
are permitted for the whole first call of every session — and permanently in a multi-worktree repo,
where another tree can hold the refresh lock indefinitely.

### Why row 9 can block reads without trapping you

Blocking reads on a broken fork point looks like it traps the agent away from the files it must
read to resolve the conflict. It does not, because **row 3 comes first**:

blocked → `pnpm wp-start-update` (row 4, skip list) → now merge-in-progress → **row 3 exempts
everything** → read and write freely to resolve → finish. The exemption row is what lets row 9 be
strict.

### Why row 8 can block reads on a dirty tree

`git checkout -b <new> origin/main` **carries uncommitted changes onto the new branch**. The work
comes with you, so nothing needs reading first and nothing is trapped. Residual: if `origin/main`
changed the same files you edited, git refuses the switch — `git stash` is on the skip list and
clears it.

Row 6 is the only place the dirty argument ever had teeth, because there the cure is `git pull`,
which genuinely is not a clean fast-forward on a dirty tree. Even there, `git stash` → `git pull` →
`git stash pop` works. **So there is no dirty row anywhere** — see "Not done" for where the code
still disagrees.

## How a log line joins to a row

Every L2 decision is written to `.webpieces/logs/L2-decisions/<writer>.log` with `layer=L2` and
`row=<n>`, where `<n>` is a row number from the table above. So `row=8` means "this call was judged
by row 8" and you read the state, the verdict and the cure straight off this page.

**The join is by REASON, not by dispatch, and the difference is worth knowing.** L1 takes the first
matching row and switches on it, so deleting an L1 row deletes a block. L2's four classes each own
their own ladder (see "The four classes" above for why they cannot be one function), and
`L2_ROW_FOR_REASON` in `l2-rows.ts` maps each ladder exit to the row it is an instance of. A unit
test reads the four guard sources and asserts every reason literal resolves to a row, so a new exit
with no row fails the build rather than logging `row=-` forever.

## The skip list (row 4)

Principle: **these get you OUT or tell you where you are.** They are not "working here".

| group | commands |
|---|---|
| get out | `git checkout -b <new> origin/main` · `git switch -c <new> origin/main` · `git switch <other>` · `git worktree add … -b <new> origin/main` |
| make `main` current | `git pull` · `git fetch` · `git checkout main && git pull origin main` *(paired only)* |
| orient | `git status\|log\|diff\|branch` · `gh pr view\|list\|status\|checks` |
| park work | `git stash` |
| repair / tooling | `pnpm wp-start-update` · `pnpm wp-start-upsert-pr` · the `wp-*` bins |

**NOT on it:** `git commit` `add` `push` `merge` `rebase` `reset` `restore` `clean` `cherry-pick` ·
`git grep` `show <rev>:<path>` `cat-file` `ls-files` (those read tracked content). **`pnpm build` /
`pnpm test` are not on it either** — there is no point running them on `main` or on a dead branch.

## Cannot tell — everything that lands on row 11

| state | expected? | treatment |
|---|---|---|
| cache absent | **yes** — the refresher populates for the NEXT call, so this fires on the first tool call of every session | fail open, log |
| detached HEAD | **yes** — mid-rebase, `git checkout <sha>` | fail open, log |
| forge unreachable | **yes** — `gh` missing, unauthenticated, rate-limited or offline | fail open, log as `no-forge` |
| branch unresolvable | **no** — not a repo, git broken | fail open, log LOUDLY |
| cache for another branch | **no** — unreachable since the cache became branch-keyed | fail open, log LOUDLY |

**Do NOT block to capture these cases.** `cache-absent` fires on every session's first call;
blocking there deadlocks every session behind a network fetch. And if a guard cannot establish
state, blocking means a *broken* guard wedges the session — the exact failure this family exists to
avoid.

`ALLOW_FAIL_OPEN` is a TYPED VERDICT, not a string suffix on the reason, so abstentions are
countable. `no-forge` is the newest member: `branchAlreadyMerged: false` used to be produced both by
"this branch has no merged PR" and by "we could not ask", and both logged a plain ALLOW — so from
the trail you could not tell whether the merged-branch policy was protecting anything or quietly
standing down.

## Not done — rows the guards do not yet honour

Each row below describes INTENT the code has not caught up with. They are listed rather than
silently rendered as if they were live, the same way L1 lists its unreachable `o` row. Every one of
them currently exits at row 11 instead, so the log never claims the strict row fired.

| row | the gap | why it has not shipped |
|---|---|---|
| 5 | Row 5 blocks `B` as well as `E` on `main`. Only `E` is blocked today: `feature-branch-guard` blocks the write, while `stale-main-bash-guard` blocks only CONTENT-READING Bash, and only once the cache proves `main` is behind. | Bash on a CURRENT `main` is harmless, and the strict form needs the skip list (row 4) to be complete first — a `B`-on-main block with an incomplete skip list wedges the session on its own cure. |
| 8 | Row 8 blocks reads on a merged branch even when the tree is DIRTY. The code opens a dirty valve and fails open (`dirty-merged-branch`, logged at row 11). | The row is the ORIGINAL documented design — `git checkout -b <new> origin/main` carries uncommitted changes onto the fresh branch, so nothing is trapped — and `read-stale-guard`'s own class comment still states it. The code drifted, and closing the valve is a behaviour change that belongs in its own PR with its own evidence, not in a config collapse. |
| 6 | Row 6 blocks reads on a stale `main` even when the tree is DIRTY. The code opens a dirty valve (`dirty-tree-on-main`, logged at row 11). | This is the one place the dirty argument has teeth: the cure is `git pull`, which genuinely is not a clean fast-forward on a dirty tree. `git stash` is on the skip list and clears it, so the strict form is reachable — but it is the same behaviour change, and the same separate PR. |

This section is generated from `NOT_DONE` in `l2-rows.ts`, so closing a gap means deleting its entry
and the doc follows — it cannot rot into a list of things that were fixed years ago.

## Incidents these guards exist because of

- **The 157-commit checkout.** An agent ran `git checkout main` in a clone whose local `main` was
  157 commits behind. That checkout reverted the `@webpieces` pin, reverted the guard shim — **the
  drift guard itself** — to a copy whose message stated the drift backwards, and so reverted the
  agent's judgment: it ran the `pnpm install` that message named and downgraded `node_modules`.
  Lesson, quoted from the code: *a guard a stale checkout can revert cannot be relied on to catch a
  stale checkout.* Hence row 2, which is preventive, matches on command TEXT only, and asks git
  nothing — deliberately, because the only `main` it could measure is the one it is about to leave.
- **The side door.** An agent on a `main` 18 commits behind (108 files, +8069/−3692 upstream) had
  its Read tool blocked exactly as designed, then spent the session `ls`-ing, `grep`-ing and
  `cat`-ing the same stale tree, and described a CI workflow set missing a 186-line workflow that
  existed upstream. *The logs read "read-stale-guard handled", which is worse than no guard: it
  looks covered.*
- **Computed and thrown away.** Both file guards are file-scoped, so Bash reached neither. An agent
  that only ran shell sailed through on a merged branch **even though `branchAlreadyMerged` was
  loaded and logged on that very path.**

---


## Code anchors

| section | file | symbol |
|---|---|---|
| the rows + the reason→row join | `ai-hook-rules/src/core/l2-rows.ts` | `L2_ROWS`, `l2RowForReason`, `NOT_DONE` |
| write policy | `ai-hook-rules/src/core/rules/feature-branch-guard.ts` | `check` |
| read policy | `ai-hook-rules/src/core/rules/read-stale-guard.ts` | `checkStaleMain`, `checkMergedBranch` |
| stale-main Bash | `ai-hook-rules/src/core/rules/stale-main-bash-guard.ts` | `staleContentRead`, `bareCheckoutOfMain` |
| merged-branch Bash | `ai-hook-rules/src/core/rules/merged-branch-bash-guard.ts` | `isFullyRecovery`, `ALLOWED_GIT_SUBCOMMANDS` |
| the cache | `rules-config/src/main-sync-status.ts`, `main-sync-file.ts` | `readMainSyncStatus`, `MainSyncStatusFile`, `forgeReachable` |
| the refresher | `ai-hook-rules/src/core/sync-main.ts` | `refreshMainSync` |
| command scanning | `ai-hook-rules/src/core/rules/content-read-scan.ts`, `shell-segment-scan.ts` | `readsStaleContent`, `classify` |
| the config key | `rules-config/src/main-sync-guard-configs.ts`, `sections.ts` | `BranchStateGuardConfig`, `BRANCH_STATE_GUARD_KEY` |
