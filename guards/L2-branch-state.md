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

> **This section will be REPLACED by a generated file.** The table below becomes an ordered array in
> code (`L2_ROWS`), the doc is rendered from it, and a unit test byte-locks the two — the same
> mechanism that already makes L0's fault table and allowlist undriftable. Until that lands this text
> is hand-written and can drift; the code wins.

## One table, ordered, first match wins

**Tools:** `B` Bash · `R` Read · `E` Write/Edit

| # | tools | state | act | cure |
|---|---|---|---|---|
| 1 | `B R E` | on the **global allowlist** (inert command or universal cure) | ALLOW | — |
| 2 | `B` | bare `git checkout main`, no `git pull` chained | **BLOCK** | `git checkout main && git pull origin main` |
| 3 | `B R E` | **merge in progress** | EXEMPT | finish the merge — L4 owns this state |
| 4 | `B` | on the **skip list** | ALLOW | — |
| 5 | `B E` | on `main` | **BLOCK** | `git checkout -b <new> origin/main` |

> ─── Everything above needs **no cache** and fires on call #1. Everything below needs the main-sync
> cache: if the branch is undeterminable, the cache is absent, or it holds another branch, **stop here
> and ALLOW**. ───

| # | tools | state | act | cure |
|---|---|---|---|---|
| 6 | `R` | on `main`, behind `origin/main` | **BLOCK** | `git pull`, or branch off |
| 7 | `R` | on `main`, current | ALLOW | — |
| 8 | `B R E` | on a **merged branch** | **BLOCK** | `git checkout -b <new> origin/main` |
| 9 | `B R E` | no fork point, or `main` collided with your files | **BLOCK** | `pnpm wp-start-update`, or `pnpm wp-start-upsert-pr` when a PR is open |
| 10 | `B R E` | healthy feature branch | ALLOW | — |

### The one rule that explains the tool column

**`B` tracks `E` everywhere. `R` is judged separately in exactly one place — rows 6/7, on `main`.**

A Read names exactly one file, so the guard can evaluate it precisely. A Bash command is opaque, so it
gets the conservative answer. Reading a CURRENT `main` is fine; the problem is that `main` is almost
always behind.

### Why row order carries the cache

L2 is armed **from the second tool call onward**. The refresher is fire-and-forget: it populates the
cache for the NEXT call, never the current one. So the first call of a session fails open and the block
lands a call or two later. That is deliberate — it keeps the blocking path free of network git — and it
is fine in practice, because the agent discovers the problem within a command or two.

The exception is **rows 2–5**, which need no cache: rows 1, 2 and 4 are text matches, row 3 is a
marker-file scan, and row 5 is one `git rev-parse`. Put row 5 BELOW the divider and writes on `main` are
permitted for the whole first call of every session — and permanently in a multi-worktree repo. That
ordering is the single most load-bearing thing in this table.

### Why row 9 can block reads without trapping you

Blocking reads on a broken fork point looks like it traps the agent away from the files it must read to
resolve the conflict. It does not, because **row 3 comes first**:

blocked → `pnpm wp-start-update` (row 4, skip list) → now merge-in-progress → **row 3 exempts
everything** → read and write freely to resolve → finish.

The exemption row is what lets row 9 be strict.

### Why row 8 can block reads on a dirty tree

`git checkout -b <new> origin/main` **carries uncommitted changes onto the new branch**. The work comes
with you, so nothing needs reading first and nothing is trapped.

This is the ORIGINAL documented design, not a new policy. `read-stale-guard`'s class comment still says
it: *"State B blocks ANYWAY, because its cure — `git checkout -b <new> origin/main` — carries
uncommitted changes onto the fresh branch, so there is nothing to resolve and nothing to be trapped
by."* The code then drifted and opened a dirty valve anyway. Row 8 restores the stated intent.

Residual: if `origin/main` changed the same files you edited, git refuses the switch. `git stash` is on
the skip list and clears it.

Row 6 is the only place the dirty argument ever had teeth, because there the cure is `git pull`, which
genuinely is not a clean fast-forward on a dirty tree. Even there, `git stash` → `git pull` →
`git stash pop` works, and stash is on the skip list. **So there is no dirty row anywhere.**

## The global allowlist — before every layer

Not L2's; it precedes L0. Two kinds of entry, and the distinction is load-bearing:

| kind | why global | entries |
|---|---|---|
| **Inert** | cannot read repo content, cannot change the repo | `pwd` `echo` `printf` `true` `false` `:` `cd` `date` `whoami` `which` `sleep` `test` `[` |
| **Universal cure** | must stay reachable or the session deadlocks | `pnpm\|npm install` · `rm -rf node_modules && pnpm install` · read **and** edit `webpieces.config.json` |

Today there is no such list: `pwd` is in L2's `ALWAYS_INERT` so L2 lets it through, but `L0_ALLOWLIST`
has never heard of it — a `pwd` blocked by fault `S` was observed live.

Build it as a third `kind` on the EXISTING `L0_ALLOWLIST` array, not a second array: that one array is
already the single source for the JS `isAllowed()`, the `grep -E` inside the rendered shim, and the
generated matrix doc.

| kind | consulted | effect |
|---|---|---|
| `pass` | only under an L0 fault | falls THROUGH; downstream layers still judge |
| `allow` | only under an L0 fault | terminal; the fault's cures |
| `global` | **every call** | terminal; never reaches any layer |

**Do NOT promote L0's "any Read" entry.** It is a `pass` on purpose; as a global allow it would bypass
L2's stale-read protection entirely.

The shim must carry it too — `D`/`X`/`K` are enforced in POSIX `sh` before the bin runs, so `pwd` only
survives a missing or broken bin if the ERE is in the shim.

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
`git grep` `show <rev>:<path>` `cat-file` `ls-files` (those read tracked content).

**`pnpm build` / `pnpm test` are NOT on it either.** There is no point running them on `main` or on a
dead branch; branch off first. This replaces a hand-maintained 31-entry git allowlist with ~14 entries,
each justified by "gets you out" rather than "seemed harmless".

## Deny messages shrink to three parts

Today's blocks run 1,500–2,000 characters and burn that much context on every hit. The shape becomes:

```
❌ <one line: why>
   Run EXACTLY: <the cure>
   Full matrix: <root>/.webpieces/instruct-ai/guards/L2-branch-state.md
```

**The cure stays literal and inline — never a pointer.** That is what preserves the anti-stuck
property: L0's cure-reachability test asserts every named cure is actually runnable, and it caught a
fault prescribing a bin that had been renamed away. A message saying "see the docs for your cure"
cannot be tested that way.

The mechanism already exists — `writeGuardMatrixDoc()` drops the generated doc into
`.webpieces/instruct-ai/` lazily on an L0 BLOCK and appends `READ <path>`. Extend it to every layer.

Precedent for generating the message rather than writing it: `merge-in-progress-guard`'s hint renders
itself from its blocked lists, because the hand-written version said "do not run other commands" — *"an
unbounded claim that forbade the reads, the `git add`, the build and the tests that finishing a merge
actually requires, and that survived every edit to these lists."*
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
