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
Write is neither.

**The two Bash guards used to differ in polarity, and no longer do.** merged-branch was
default-DENY + allowlist; stale-main was default-ALLOW + blocklist, so `pnpm build` was denied by
one and allowed by the other for the same reason — "you should not be working in this tree". That
asymmetry was a consequence of stale-main asking about FRESHNESS, where a blocklist of content
readers is the right shape. Once it asks about the BRANCH instead (row 5), the right shape is the
one merged-branch already had, and they now share it: `RecoveryAllowlist`, the row 4 skip list, as
a single implementation. Two skip lists drift, and the half that drifts is the half that wedges a
session on its own cure.

They remain separate CLASSES because the states they detect are different — one reads the branch
name, the other the cached merged flag — and because each carries its own message.

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

Row 6 looked like the one place the dirty argument had teeth, because its FIRST cure is `git pull`,
which genuinely is not a clean fast-forward on a dirty tree. But row 6 has always carried a SECOND
cure — `git checkout -b <new> origin/main` — and that one works dirty for exactly the reason above.
The teeth were in the MESSAGE, which printed only the pull; it now prints both, labelled, so the
cure an agent reads is always one it can run. **So there is no dirty row anywhere, and no dirty
valve in the code either** — both were closed, and "Not done" is empty as a result.

## L2 use cases

Same row shape as L0 and L1: the **Fix** is literal or it is not a fix. Each case is attached IN
CODE to the row that judges it (`useCases` on `L2Row`), so this table cannot describe a row that no
longer exists and a row cannot quietly acquire behaviour nothing documents.

**This table is how the layer LEARNS.** When a new situation comes up in a session, the change is
one more `new L2UseCase(...)` on the row that judged it — not a paragraph added here, which the
byte-lock spec would reject anyway. Every case also carries the exact `reason` string the guard
logs, and a spec pushes that back through `l2RowForReason` to assert it lands on the row it is filed
under. So a case whose row is wrong fails the build rather than misinforming a reader.

| # | what you SEE (exact symptom) | state | verdict | Fix |
|---|---|---|---|---|
| 1 | You are blocked by some other L2 row, and need to turn the policy off to get anything done | any state — this row is ahead of every block | ALLOW: reading and editing `webpieces.config.json` is never blocked, so the mode-OFF cure is always reachable | Edit `webpieces.config.json` → `hookGuards` → `branch-state-guard` → `"mode": "OFF"` |
| 2 | A Write to `webpieces.config.json` while on `main`, which row 5 would otherwise block | on `main`, editing the one file that can disable the guard | ALLOW: the hook adapter bypasses feature-branch-guard for this path before any guard runs | None needed — the edit proceeds |
| 3 | `git checkout main` after a merge, to start the next piece of work | about to land on whatever local `main` you last had — 157 commits behind, in the incident | BLOCK: decided from command TEXT alone, before the checkout, because the only `main` this could measure is the one it is about to leave | `git checkout main && git pull origin main` — the pull must be in the SAME command |
| 4 | The same command inside a linked worktree, where `git checkout main` fatals anyway | linked worktree — `main` is already checked out in the primary clone | BLOCK, and the message prints the worktree form rather than a cure git would refuse | `git fetch origin main`, then work off `origin/main` |
| 5 | Reading and editing conflicted files during a 3-point merge, on a branch row 9 would block | merge markers on disk — `pnpm wp-start-update` has run and not finished | EXEMPT: everything is permitted, which is exactly what lets row 9 be strict | Resolve the conflicts, then `pnpm wp-finish-upsert-pr` |
| 6 | `git status` / `gh pr view` while blocked, to work out where you are | any state — orientation is never "working here" | ALLOW: metadata tells you where you are without putting stale file CONTENT in context | None needed |
| 7 | `git stash` to clear a dirty tree so the prescribed `git pull` can fast-forward | on a stale `main` with local modifications | ALLOW: the cure for the row that blocked you must itself never be blocked | None needed — then run the pull and `git stash pop` |
| 8 | `pnpm wp-start-upsert-pr` on a branch whose fork point is broken | row 9 state, running the tool row 9 prescribes | ALLOW: every `wp-*` bin is on the skip list, so no row can block its own remedy | None needed |
| 9 | An Edit or Write to any tracked file while `git rev-parse --abbrev-ref HEAD` says `main` | on `main`, any freshness | BLOCK: decided by one `git rev-parse`, with NO cache read, so it fires on the first tool call of the session | `git checkout -b <new> origin/main` — uncommitted work comes with you |
| 10 | A Bash command that WRITES tracked files as a side effect — `npx expo install`, a formatter, codegen, `sed -i`, a `>` redirect | on `main`, and the write is incidental to a command whose stated purpose is something else | BLOCK: default-DENY on `main` plus row 4's skip list, so a command nobody thought to enumerate is caught by not being on the list — which is the only shape that could have caught this one | `git checkout -b <new> origin/main` BEFORE running anything that may write |
| 24 | A build or a test run on a `main` that is perfectly up to date | on `main`, current — no staleness anywhere | BLOCK: freshness is not the question. `main` is not a place to work even when current, and the cure is a new branch, not a pull | `git checkout -b <new> origin/main` |
| 16 | Read is blocked, so the session reaches for `cat`, `grep` and `ls` instead — and describes a CI workflow set missing a whole workflow that existed upstream | the SIDE DOOR: same tree, different tool | BLOCK. This case used to be judged by row 6 (a stale-content blocklist on the Bash side); row 5 now subsumes it, because being on `main` is already the finding and no enumeration of readers is needed. The log used to read "read-stale-guard handled", which is worse than no guard — it looks covered | `git checkout -b <new> origin/main` |
| 25 | The FIRST command of a session, on `main`, before any cache exists | on `main`, cache absent — row 11 would fail open | BLOCK anyway: row 5 is ABOVE the cache divider and reads only `git rev-parse`, so it is armed on call #1. This is the case the cache-gated version could never catch | `git checkout -b <new> origin/main` |
| 11 | The very first tool call of a session is allowed even on a badly stale `main` | no cache — the refresher is fire-and-forget and populates it for the NEXT call | ALLOW (fail-open), logged as `ALLOW_FAIL_OPEN` so abstentions stay countable | None — the second call is judged normally |
| 12 | Guards quietly stand down on a plane, or when `gh` is unauthenticated or rate-limited | the forge could not be asked whether the PR is merged | ALLOW (fail-open) logged as `no-forge` — distinct from "asked, and it is not merged", which used to look identical in the trail | None — restore network/`gh auth` to re-arm the merged-branch policy |
| 14 | Mid-rebase, every guard abstains | detached HEAD — there is no branch name to judge | ALLOW (fail-open), logged LOUDLY when the branch is unresolvable rather than merely detached | None — finish or abort the rebase |
| 13 | The Read tool refuses a file on a stale `main` while you have UNCOMMITTED edits | on `main`, behind `origin/main`, dirty tree | BLOCK. This used to fail open, on the argument that the prescribed `git pull` is not a clean fast-forward when the tree is dirty. That was true of the MESSAGE, not the row: the cure cell always offered a second form, and it works dirty | `git checkout -b <new> origin/main` — uncommitted changes come with you onto the new branch. If git refuses because `origin/main` touched the same files, `git stash` first (never blocked), then retry, then `git stash pop` |
| 15 | The Read tool refuses a file that exists, on a `main` 18 commits behind | on `main`, behind `origin/main`, clean tree | BLOCK: judged by live ancestry (`git merge-base --is-ancestor`), not hash equality, so a pull takes effect instantly | `git pull origin main`, or `git checkout -b <new> origin/main` |
| 17 | Reading files on a `main` you just pulled | on `main`, and `origin/main` is an ancestor of HEAD | ALLOW: this is the ONE place a Read is judged differently from a Bash command, because a Read names exactly one file and can be evaluated precisely | None needed |
| 18 | You keep working on the branch after its PR merged, and the next PR reopens code review already landed | branch whose PR is merged — `merged` is monotonic, so the cached flag is trusted with no TTL | BLOCK across all three tools | `git fetch origin main && git checkout -b <new> origin/main` |
| 26 | You have uncommitted edits on a branch whose PR just merged | merged branch, dirty tree | BLOCK. This used to fail open too, and that valve never had an argument behind it — row 8's cure carries uncommitted work onto the fresh branch, so nothing was ever trapped. It was drift from the documented design, which `read-stale-guard`'s own class comment still described correctly | `git fetch origin main && git checkout -b <new> origin/main` — your edits come with you |
| 19 | A shell-only session sails through on a merged branch | merged branch, Bash only — both FILE guards are file-scoped, so Bash reached neither | BLOCK: `merged-branch-bash-guard` exists because `branchAlreadyMerged` was being computed and logged on that very path, then thrown away | `git fetch origin main && git checkout -b <new> origin/main` |
| 20 | Your branch and `origin/main` share no merge base — usually a branch cut from a squashed-away tip | no fork point | BLOCK: nothing built on this branch can be reasoned about relative to main | `pnpm wp-start-update`, or `pnpm wp-start-upsert-pr` when a PR is open |
| 21 | `origin/main` moved and changed the same files you edited | main-moved collision | BLOCK — and row 3 then exempts everything once the merge starts, which is what makes this safe | `pnpm wp-start-update`, resolve, `pnpm wp-finish-upsert-pr` |
| 22 | Ordinary work on a branch cut from a current `origin/main` | healthy feature branch | ALLOW — the state every other row exists to push you back into | None needed |
| 23 | `stale-main-bash-guard` sees a feature branch and hands off | not on `main` — state B belongs to `merged-branch-bash-guard` | ALLOW: the same verdict about the same tree, logged by the guard that is not responsible for it | None needed |

The write-on-main case under row 5 is the one to read beside "Not done": it is a real incident from
another repo on this toolchain, where `npx expo install` on `main` modified two tracked files and no
guard fired. It is filed under row 5 because row 5 is the row that SHOULD judge it — the table states
the policy, and "Not done" states how far the code has got. That is the arrangement that keeps a gap
visible instead of letting the doc quietly narrow itself to whatever the code happens to do.

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

**Nothing. Every row in the table above is a row the guards actually honour today.**

That has not always been true, and the section stays here for when it stops being true again:
a row the code cannot yet honour is listed here rather than rendered as if it were live, the
same way L1 lists its unreachable `o` row. The three entries this section used to carry were
row 5's Bash half (now judged from the branch alone, above the cache divider) and the DIRTY-TREE
valves on rows 6 and 8 — both closed, because each of those rows cures with
`git checkout -b <new> origin/main`, which carries uncommitted changes onto the new branch. A
dirty tree never trapped anyone; the row 6 message just printed the one cure that could not run
dirty, and the fix was to print both.

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
