# L1 — location

**Goal: is this call ours to judge, is this tree governed by the release it asks for, and is git being run from the root?**

**Config key: none, and none is proposed.** Force-to-root and trinary-version-skew have **no config
key** and cannot be disabled; `excludePaths` is a top-level block, not a `hookGuards` entry. A
`location-guard` key was once proposed here — it never existed, and `hookGuards` has just gone from
nine keys to three, so adding a tenth-turned-fourth for a layer nobody has asked to switch off would
run against the whole point. L0 has no key for the stronger version of the same reason: a layer that
decides whether the tooling can be trusted cannot be configured by the file it has not validated yet.


**Code:** `packages/tooling/ai-hook-rules/src/core/effective-tree.ts` (`EffectiveTreeResolver`,
`TreeKind`) · `packages/tooling/ai-hook-rules/src/core/target-tree.ts` (`TargetTreeResolver`,
`GovernedPath` — the same question asked about a FILE) ·
`packages/tooling/ai-hook-rules/src/core/runner.ts` (`l1LocationBlock`, the `foreign` check) ·
`packages/tooling/ai-hook-rules/src/core/excluded-paths.ts` (`filterByExcludedPaths`) ·
`.../force-to-root.ts` (`ForceToRootGuard`) ·
`packages/tooling/ai-hook-rules/src/core/missing-directory.ts` (`MissingDirectoryGuard`) ·
`packages/tooling/ai-hook-rules/src/core/version-sync.ts` (`VersionSyncGuard`,
`WebpiecesVersions`).

L1 answers four questions, and they are genuinely separate:

1. **Do we govern this at all?** — the escape hatches, for other repos and non-governed paths.
   Answered by asking GIT (`--git-common-dir`), never by path math: see the legend under **K**.
2. **Does the directory still EXIST?** — row 7. A worktree reaped out from under a live shell leaves
   a cwd that names nothing, and that state needs its own name and its own message, because the
   remedy for "you are in a subdirectory" is a `cd` back into the very directory that is gone.
3. **Is this tree governed by a release it did not ask for?** — row 8. A worktree MAY have its own
   `node_modules` (nx, vitest and the eslint plugin all execute there and load from it), and when it
   has none the shim's upward walk runs the main tree's binary. Either way the rule is the same and
   holds whichever registration form — absolute or relative — is live in the consumer: the two trees
   must PIN the same `@webpieces`, or the worktree is linted, validated and built by a release its
   own manifest does not ask for. Asked of the PATH acted on, never of who is asking —
   agent identity was measured untrustworthy for tree detection (a worktree-isolated agent whose tree
   is auto-reaped at a turn boundary silently resumes on the primary clone).
4. **Is the agent stranded away from the root?** — force-to-root, git/gh only. Agents forget where
   they are constantly, and `cd` gives them two different ways to be wrong: a `cd` that stays INSIDE
   the workspace PERSISTS to later calls (so the shell can be parked in a subdirectory left by an
   unrelated command turns earlier), while a `cd` that LEAVES it is reset by the harness, which says
   so — `Shell cwd was reset to <root>`. Neither can be assumed, which is why every remedy names the
   root explicitly instead of telling the agent to `cd` first.

## Preamble — resolve the target first (Bash only)

`EffectiveTreeResolver.resolve()` computes `effectiveCwd`: the directory the command actually runs in,
which is the shell's cwd unless the command leads with `cd <dir> &&`. **K is classified from
`effectiveCwd`, not from the shell's cwd** — so "a foreign repo that `cd`s into ours" is not a cell,
it is simply `pw` after resolution.

That holds because K is resolved by ASKING GIT about `effectiveCwd`, not by testing whether the path
is lexically under the governed root. It has to be said that way round: the resolver used to do the
path test, and a linked worktree under `.claude/worktrees/**` therefore resolved `f` — every bash
guard exempt in the one sandbox agents are told to work in. A sentence in this file asserted the
opposite as fact for several releases, which is how it went unnoticed.

Only a LEADING run of `cd`/`pushd` counts. A *trailing* `… && cd <exempt-tree>` must never
retroactively pull a command out of scope — that would smuggle a root-level `git push` past the
guards. Quoting is handled by `ShellSegmentScan`, so `echo "cd sub && git push"` is one opaque
segment and its quoted `cd` is never picked up.

## Filter — not a dimension (all tools)

`filterByExcludedPaths` drops every rule excluded for this path: the **target path** for
Read/Write/Edit, `effectiveCwd` for Bash. An empty rule list means allow. This is a filter, not a row:
"exempt" is what emerges when the list empties.

ONE path is filtered out BEFORE the list is consulted and cannot be put back: **`.webpieces/`**,
the tooling's own state dir (`isWebpiecesStateDir`). It is gitignored in every consumer, so nothing
under it can reach a branch, be reviewed or be reverted — every reason L2 prints for protecting
`main` is vacuous there. It was config-only once, which made the exemption optional on exactly the
directory webpieces itself writes to: `wp-review-upsert-pr` hands a reviewer subagent a
`<primary>/.webpieces/worktrees/agent-＜id＞/pr-review/…` path, that write resolves to the PRIMARY
clone, and L2 judged the primary's live branch — so the reviewer was denied "You should not be
working on main" whenever an unrelated session had left the primary there. There is deliberately
NO companion `".webpieces/**"` glob seeded into `excludePaths`: a config entry that changes
nothing is a second and WEAKER spelling — the matcher below misses the bare directory that the
predicate matches — and it invites a consumer to delete it and believe the exemption went too.

<!-- webpieces-disable no-state-paths-in-templates -- this paragraph's subject IS the two spellings of the state dir; a computed path would print one of them and lose the contrast -->
The skip is asked about the path relative to the tree that **OWNS** the file, not to the governed
root, and the two differ in exactly one place: a linked worktree. `<primary>/.webpieces/…` was
exempt while `<primary>/.claude/worktrees/agent-＜id＞/.webpieces/pr-review/…/review.json` — the same
kind of file, in a worktree's own state dir — was not, because governed-root-relative it begins
`.claude`. That is the file `wp-review-upsert-pr` REQUIRES before `wp-finish-upsert-pr` will open a
PR, so the guard could forbid a file the gate demands (issue #851). `GovernedPath` carries both
spellings together so a caller cannot reach for the wrong one.

`excludePaths` is **ONE glob list** (canonical: `"excludePaths": ["repositories/**"]`). The
`{ rules: [...], guards: [...] }` object is **retired and rejected**, with the union it must become
named in the error. `wp-install-ai-hooks` migrates it in place.

This used to be a tolerated fallback, justified here by "rejecting it would block every Bash/Edit
including the edit that would fix it." **That was never true**, and the fallback it licensed is why
consumer configs — this repo's own included — sat on the dead shape for releases. A Write/Edit whose
target is `webpieces.config.json` is an unconditional **PASS** (see the L0 table above), and
`pnpm install` has an installer bypass, so an invalid config can always be repaired from inside the
block. Config rejection is self-recoverable by construction; see `retired-config-keys.ts` for the
policy and the reasoning.

## Legend

| col | dimension | values |
|---|---|---|
| **K** | tree kind of the resolved target, from git's own dirs | `f` foreign repo (a DIFFERENT `--git-common-dir`) · `m` the directory does not exist · `o` outside any repo · `w` a LINKED worktree of ours (`--git-dir` ≠ `--git-common-dir`), wherever it sits on disk · `pw` ours (primary **or** worktree) |
| **V** | do the `@webpieces` versions agree between this worktree and the MAIN tree | `n` skewed · `y` in sync |
| **R** | command is provably read-only inspection | `n` · `y` |
| **G** | command invokes git/gh | `n` · `y` |
| **P** | position of the resolved target | `root` · `sub` |

All of them are **Bash only**. Read/Write/Edit resolve their own target (`input.filePath`) and have no
dimensions — the filter is all that applies to them. **The Read tool is never blocked by L1.**

A linked worktree is deliberately **not** foreign: it is the same project, so the guards run against
THAT tree's branch and cache. Every rule-scoped guard treats `p` and `w` alike, hence `pw`; row 8 below
is the ONE place they separate, and it turns on **V** — the versions, read off the tree itself.

PLACEMENT IS NOT IDENTITY. A worktree checked out INSIDE the repo — `<repo>/.claude/worktrees/agent-XXXX`,
which is where Claude Code puts every agent worktree — is `w` exactly like a sibling `../feature-dir` one.
K comes from git's own dirs (`--git-common-dir` is identical for every checkout of one repo,
`--git-dir` differs only in a linked worktree), never from whether the path sits under the governed root.
It used to short-circuit on that path test, so an in-repo worktree read as `f` — every bash guard exempt,
and row 8 unreachable, for the only layout the harness actually produces. A nested clone under
`repositories/**` still reads `f`, because its shared git dir is its own.

`V` comes from reading manifests off disk — the MAIN tree's `pnpm-workspace.yaml` catalog pin, its
installed `node_modules` version, this worktree's pin, and this worktree's own installed version when
it has one (which it does the moment anyone runs `pnpm add` there). Three always, a fourth when
present. Anything unreadable is NO OPINION, never skew: a guard that cannot measure must not block.
It is deliberately NOT read from `agent_id`/`agent_type` — the dimension this replaced was, and a
worktree-isolated agent was measured resuming on the primary clone after its tree was reaped, so who
is asking cannot be trusted to say which tree is being acted on.

`R` is `ReadOnlyInspectionScan` — the same paranoid "provably inert" test the unloadable-config escape
hatch uses (allowlisted viewers/searchers only, no redirects, no `sed -i`).

## Table

| # | K | V | R | G | P | act | why | cure |
|---|---|---|---|---|---|---|---|---|
| 0 | – | – | – | – | – | 4 block | a `cd` that is not leading + literal, judged before any tree is resolved | `cd <literal abs path> && <the rest>` — ONE leading `cd`, or drop it |
| 1 | `f` | - | - | - | - | 2 exempt | different git repo — hands off | n/a — not a block |
| 2 | `o` | - | - | - | - | → L2 | see "Not done" below | n/a — not a block |
| 8 | `w` | `n` | `n` | - | - | 4 block | this worktree pins a DIFFERENT @webpieces than the main tree that governs it | align the pins (same git hash -> same tracked pin -> install in each tree), work in the main tree, or use a separate clone |
| 4 | `pw` | - | - | `n` | - | → L2 | force-to-root has no jurisdiction | n/a — not a block |
| 5 | `pw` | - | - | `y` | `sub` | 4 block | `cd <root> && <original>` | `cd <root> && <original>` |
| 6 | `pw` | - | - | `y` | `root` | → L2 | | n/a — not a block |
| 7 | `m` | - | - | - | - | 4 block | the directory is GONE — nothing can run there | `cd <root> && <the work>`, never back through the dead path |

Rows 3, 5 and 7 are the structural blocks, and they run as ONE step (`l1LocationBlock` in `runner.ts`)
so they can never be reordered by accident — row 7 (the directory is gone) first, then row 8, then
force-to-root. Row 7 is printed LAST above only because row numbers are stable across releases and
renumbering 1-6 would invalidate every `row=` in the logs; `m` matches no other row, so its position
in the scan is immaterial. All three sit after the L0
allowlist, after the `f` check, and after the `excludePaths` filter and the config-sync check. So a
cure (`cd <worktree> && pnpm install`) still reaches any tree: that is L0's invariant, and row 8 does
not weaken it.

## How a log line joins to a row

Every L1 decision is written to `.webpieces/logs/L1-location/<writer>.log` with `layer=L1` and
`row=<n>`, where `<n>` is a row number from the table above. So `row=6` means "this call was judged
by row 6" and you read the dimensions, the verdict, the reason and the cure straight off that line. Row `0` is
the pre-stage; it is in the table for exactly this reason.

**The join is by DISPATCH, and that is the difference from L2.** L1 takes the FIRST matching row in
`L1_ROWS` and switches on it, so a row and a behaviour are the same object — delete the row and you
delete the block. L2's four guard classes each own their own ladder and join to their rows by REASON
instead (see `webpieces.branch-state-matrix.md`). A totality test walks all 80 classifications and
asserts each lands on exactly one row, so there is no verdict this page cannot explain.

Row numbers are IDENTITY and are never reused: row 3 is retired (coordinator-in-worktree) and row 8
was added in its place rather than renumbering 4-7, because every `row=` already written to a log
would otherwise re-point.

## L1 use cases

Same row shape as L0: the **Fix** is literal or it is not a fix. `<root>` is the absolute workspace
root — the messages name it explicitly rather than telling you to `cd` first, for the reason in the
section head (neither the shell's cwd nor a `cd`'s persistence can be assumed).

| # | what you SEE (exact symptom) | state | verdict | Fix |
|---|---|---|---|---|
| 1 | `cd repositories/vendored && git commit` goes through untouched | `f` / `y` / - — row 1 | ALLOW_EXEMPT | none needed — jurisdiction is judged on the RESOLVED target, after the `cd`; a different git repo is hands-off |
| 2 | Edit `repositories/vendored/foo.ts` allowed even on stale main | filter — the path is in `excludePaths` | ALLOW_EXEMPT | none needed |
| 3 | Edit `packages/http/foo.ts` blocked on stale main | filter keeps the rules → L2 fires | BLOCK (at L2) | that is L2's write-on-main verdict, not L1's — follow the L2 message |
| 4 | Edit `packages/http/foo.ts` judged even though the shell is in `/tmp` | filter, on the TARGET path | → L2 | none — for file tools the cwd is irrelevant; do NOT `cd` anywhere to "fix" it |
| 5 | `ls` from `packages/http/` runs normally | `pw` / `n` / - — row 4 | ALLOW (handed to L2) | none — force-to-root has no jurisdiction over non-git commands |
| 6 | `pnpm test` from `packages/http/` runs normally | `pw` / `n` / - — row 4 | ALLOW (handed to L2) | none — deliberately untouched, so package-local test runs stay natural |
| 7 | `git status` from `packages/http/` is blocked | `pw` / `y` / `sub` — row 5 | BLOCK_AI_CURE | Option 1 (preferred): `cd <root> && git status` |
| 8 | `cd packages/http && git status` **typed from the root** is blocked | `pw` / `y` / `sub` — row 5 | BLOCK_AI_CURE | Option 1 (preferred): `cd <root> && git status`<br>Do NOT: assume it is allowed because you started at the root — the predicate is `effectiveCwd === root`, i.e. the DESTINATION |
| 9 | `cd <root> && git status` passes from anywhere | `pw` / `y` / `root` — row 6 | ALLOW (handed to L2) | none — this IS the prescribed cure |
| 10 | `echo "cd sub && git push"` passes | `pw` / `n` / `root` — row 4 | ALLOW (handed to L2) | none — the `cd` is inside quotes, so `ShellSegmentScan` never treats it as a scope escape |
| 11 | `cd <subdir> && git push` blocked with the force-to-root message, NOT the gated-flow one | `pw` / `y` / `sub` — row 5; force-to-root runs first | BLOCK_AI_CURE | Option 1 (preferred): `cd <root> && git push`, which then gets the push guard's real answer ← costs one extra turn by design; still blocked |
| 12 | a worktree on an older branch pins `0.4.612` while the main tree runs `0.4.616`, and `cd <wt> && pnpm build` is blocked | `w` / `n` / `n` — row 8 | BLOCK_AI_CURE | Option 1 (preferred): the MAIN tree is AHEAD, so this is YOURS and it is a one-line edit — raise THIS tree's catalog pin in `pnpm-workspace.yaml` to what main already runs, then `pnpm install` here if this tree has a node_modules. That edit is on the L0 allowlist, so it is typable while the block is up, and nothing has to move in the main tree<br>Option 2: do the work in the main tree, which this guard never blocks<br>Option 3: if the tree genuinely needs a DIFFERENT version, use a separate CLONE — a clone gets its own governance. That is the answer to "I need a different version", never to "I need to install here": a worktree MAY have its own node_modules (nx, vitest and the eslint plugin all load from it), it just may not hold a different @webpieces version<br>Do NOT: lower the MAIN tree's pin to match — that downgrades every tree, including this session's own governor. And do NOT reach for `pnpm install` BEFORE the edit: this tree's pin is the stale side, so installing first materializes the OLD release |
| 13 | the same command from a **subagent** runs normally | `w` / `y` — row 8 does not match | ALLOW (handed to L2) | none — a subagent pinned to a worktree is the correct pattern |
| 14 | inspection inside a SKEWED worktree still runs — `cd <worktree> && ls`/`cat`/`grep` | `w` / `n` / `y` — row 8 does not match | ALLOW (handed to L2) | none — inspection is always open; so are the `Read` tool, `git -C <dir INSIDE this tree> …` and `git show <branch>:<file>`, none of which move you. `git -C <ANOTHER tree>` is a different matter: the harness refuses cross-tree git to a subagent, so it is never the cure for a skew — tell the MAIN agent instead |
| 15 | `cd <worktree> && pnpm install` still runs while row 8 is live — it is the CURE | L0 allowlist, ahead of L1 | ALLOW | none — a cure must stay reachable from every tree |
| 16 | a SUBAGENT hits the same block inside `.claude/worktrees/agent-XXXX` | `w` / `n` / `n` — row 8; in-repo placement is still `w` | BLOCK_AI_CURE | READ THE DIRECTION FIRST — the deny prints it. If the MAIN tree is AHEAD (the common case) a subagent fixes this ITSELF, here, by raising this tree's pin to what main already runs; there is nothing to escalate and the deny prints no escalation. Only when main is BEHIND, or when this branch bumped the pin on purpose, is the subagent stuck — the main tree is outside its tree, and a worktree-isolated agent may not even still be in the tree it was launched in (measured: auto-reaped at a turn boundary, resumed on the primary). Then, and only then, forward the deny's verbatim ask to the coordinator and STOP<br>Do NOT: expect exemption because it sits under the repo — K is git's `--git-common-dir` answer, not a path test |
| 17 | the printed cure REPLACES your `cd`, it does not stack in front of it | `pw` / `y` / `sub` — row 5, on the cure itself | BLOCK_AI_CURE | Option 1 (preferred): run the printed line VERBATIM — `cd <root> && <the work>`, with your own leading `cd` dropped<br>Do NOT: paste `cd <root> && cd <subdir> && <work>`; `effectiveCwd` resolves the leading `cd`s left to right, so that lands in `<subdir>` again and re-fires this exact block |
| 18 | every command from a worktree another agent REAPED mid-session is blocked | `m` — row 7 | BLOCK_AI_CURE | Option 1 (preferred): run the printed `cd <root> && <the work>` line — it does NOT route back through the dead path<br>Do NOT: re-`cd` into the worktree, or `git worktree add` it back expecting your uncommitted work; that work is gone |
| 19 | the same block for a NON-git command there — `m` does not care about G | `m` — row 7; K alone decides it | BLOCK_AI_CURE | Option 1 (preferred): the same printed line. A vanished cwd is not a git question — nothing at all can run in a directory that does not exist |
| 20 | Write `.webpieces/worktrees/agent-＊/pr-review/…/review-＊.json` allowed on main, with `excludePaths` empty | filter — `.webpieces/` is HARD-CODED exempt (`isWebpiecesStateDir`), ahead of the config list | ALLOW_EXEMPT | none needed — the dir is gitignored, so no config can put it back under governance |
| 21 | Write a reviewer verdict into a WORKTREE's own state dir — the `.webpieces` under `.claude/worktrees/agent-＊`, not the primary's | filter — the state-dir skip is asked about the path relative to the tree that OWNS it, not the governed root | ALLOW_EXEMPT | none — it was NOT exempt before (governed-root-relative that path begins `.claude`), and `wp-review-upsert-pr` requires the file before a PR can be opened |

Row 8 is the one that changed. It used to be ALLOWED, because the predicate was
`shellAtRoot || cdsToRoot` — two variables OR'd, so the same destination got opposite verdicts
depending on where the shell happened to start. It is now one variable, `effectiveCwd === root`.

Row 12 is the incident that produced table row 8, and it is a VERSION SKEW incident — which is why
the row that replaced it measures versions rather than agent identity. The coordinator ran
`git worktree add`, `cd`'d in,
and worked there. An L0 version-drift fault then fired against the PRIMARY (pin `0.4.545` vs
`node_modules` `0.4.526`) and prescribed `pnpm install` — which ran in the WORKTREE, internally
consistent at `0.4.526`/`0.4.526`, so it succeeded, changed nothing in the measured tree, and the guard
re-denied. Five identical installs later the agent had invented a theory about the harness stripping
its `cd` and handed the problem to the human. Note what row 15 says: the fix is NOT to deny that
install. It is to make the split state unreachable, so the wrong-tree install is never plausible.

## Not done — `o` is not exempt yet

Row 2 hands `'outside'` down to L2 rather than exempting it. `'outside'` is produced at
`effective-tree.ts` (git has no answer for the directory) carrying `governedRoot`, and **no code branches on it**, so a
command in no git repo is judged against the governed repo's branch and staleness state. That is a
wrong verdict, and `exempt` is the right action.

**It must not ship alone.** Jurisdiction comes from the shell cwd, not from what the command touches,
so exempting `o` opens a bypass an agent reaches by typing `cd /tmp &&`:

| command | today | with `o → exempt` alone |
|---|---|---|
| `cd /tmp && ls` | judged against the repo | exempt — **correct** |
| `cd /tmp && git -C $REPO commit` | L2 guards fire | exempt — **every L2 guard bypassed** |
| `cd /tmp && rm -rf $REPO/packages/http/src` | judged | exempt — **unguarded** |

The two cases only separate once jurisdiction is judged on **what the command touches** (explicit
`git -C` / `--work-tree`, then path arguments, then the `cd`, then the shell cwd), with the fail-safe
rule that **any** resolved target inside `governedRoot` means `pw`. Ship the two together, or neither.

Tracked in `backlog/bug-bash-guards-judge-the-shell-cwd-not-the-paths-the-command-touches.md` and
`backlog/bug-outside-tree-kind-is-never-consumed-so-a-non-git-dir-is-judged-against-the-governed-repo.md`.
That resolver has three consumers — L1's K, L2's scope dimension, and `excludePaths` on the Bash path
— which is why the backlog says **fix once**.

---


## Code anchors

| section | file | symbol |
|---|---|---|
| resolver, K | `ai-hook-rules/src/core/effective-tree.ts` | `EffectiveTreeResolver`, `TreeKind` |
| the two structural blocks, in order | `ai-hook-rules/src/core/runner.ts` | `l1LocationBlock` |
| trinary-version-skew (row 8), V, R | `ai-hook-rules/src/core/version-sync.ts` | `VersionSyncGuard`, `WebpiecesVersions` |
| force-to-root (row 5) | `ai-hook-rules/src/core/force-to-root.ts` | `ForceToRootGuard` |
| the directory is gone (row 7) | `ai-hook-rules/src/core/missing-directory.ts` | `MissingDirectoryGuard` |
| the filter | `ai-hook-rules/src/core/excluded-paths.ts` | `filterByExcludedPaths` |
| which tree owns a TARGET PATH | `ai-hook-rules/src/core/target-tree.ts` | `TargetTreeResolver`, `GovernedPath` |
| `excludePaths` shape | `rules-config/src/exclude-hook-paths.ts`, `validate-config.ts`, `retired-config-keys.ts` | `ExcludePaths`, `validateExcludePaths` |
| the `.webpieces/` skip | `rules-config/src/exclude-hook-paths.ts` | `isWebpiecesStateDir` |
