# Guard decision matrices — L0 and L1

The webpieces PreToolUse guards are layered. Each layer is an **ordered pattern list** — first match
wins, exactly like the if/else chains the code already is. This file documents L0 (tooling integrity)
and L1 (location). L2–L4 are not yet tabled here.

> **This document is hand-written and CAN go out of date.** The code is the authority. Every section
> below names the exact file and function it describes, and those functions carry a comment pointing
> back here. If the two disagree, **the code wins and this file is the bug** — fix it in the same PR
> that changed the behaviour.
>
> One exception: L0's table and allowlist are also **generated** from the arrays the guard actually
> consults, and that generated copy cannot drift. See "The generated L0 doc" below.

## Action codebook

| # | action | meaning |
|---|---|---|
| 1 | `ALLOW` | in scope, nothing wrong |
| 2 | `ALLOW_EXEMPT` | out of scope by construction |
| 3 | `ALLOW_FAIL_OPEN` | state could not be established; allow and log |
| 4 | `BLOCK_AI_CURE` | blocked; the AI can run the printed cure itself |
| 5 | `BLOCK_HUMAN` | blocked; needs a human decision |

Keeping 3 distinct from 1 is the point: a fail-open allow and a real allow must not look identical in
the logs, or nobody can tell whether the guards are protecting anything or quietly abstaining.

---

# L0 — tooling integrity

**Code:** `packages/tooling/ai-hook-rules/src/core/l0-matrix.ts` (faults, doc rendering) ·
`packages/tooling/ai-hook-rules/src/bin/l0-allowlist.ts` (the one allowlist) ·
`packages/tooling/ai-hook-rules/src/adapters/hook-core.ts` (`enforceCommittedShim`,
`shimStaleRecoveryDecision`) · `packages/tooling/ai-hook-rules/templates/ai-hook.sh` (the `sh` half).

L0 blocks work while `node_modules`, the committed shim, or `webpieces.config.json` are in a state
that makes every other guard untrustworthy.

## The six faults

| code | fault | detected + enforced in |
|---|---|---|
| `D` | version drift — root package.json pin != installed version | POSIX `sh`, before the bin runs |
| `X` | guard bin missing (fresh clone, new worktree, package removed) | POSIX `sh`, before the bin runs |
| `K` | guard bin present but CRASHED (exit code not 0 or 2 — corrupt node_modules) | POSIX `sh`, before the bin runs |
| `S` | committed `.claude/webpieces/ai-hook.sh` != `renderShim()` | the guard bin, in JS |
| `C` | `webpieces.config.json` missing | the guard bin, in JS |
| `Y` | a loaded rule has no `webpieces.config.json` key | the guard bin, in JS |

`D`/`X`/`K` are decided in `sh` **before the bin runs** — a stale, missing or broken validator cannot
be trusted to validate itself.

## Ordering is real, not just a matrix

- `D` is computed FIRST and gates whether the bin runs at all: `if [ -x "$BIN" ] && [ -z "$DRIFT_PKG" ]`.
  So `D` and `K` are mutually exclusive by construction.
- Deny-message precedence in `sh`: `K` → `D` → `X`.
- JS side: `enforceCommittedShim` runs before the Read/Bash/Edit dispatch, so `S` precedes `C` and `Y`.
- **`Y` is NOT outermost.** On the Bash path `checkConfigSync` runs *after* L1's foreign check and
  `excludePaths` filter. That is deliberate — do not demand a config key for a rule that was excluded
  anyway — but it means "L0 is the outermost layer" is not literally true for `Y`.

## The matrix

L0 has **no genuine second dimension**. Every branch reduces to one question:

| # | fault | on the allowlist? | act |
|---|---|---|---|
| 1 | none | — | → L1 |
| 2 | any | yes | 2 — PASS or ALLOW (see the entry) |
| 3 | any | no | 4 — BLOCK; **only the message varies by fault** |

The tool is not a dimension either: "any Read" is an allowlist ENTRY, not a tool check.

## The allowlist

ONE list, consulted identically by all six faults. A cure that cannot help a given fault also cannot
hurt it, and gating each entry on a fault is what produced four real defects.

| # | allowed | outcome |
|---|---|---|
| 1 | any Read | PASS |
| 2 | a Write/Edit whose target is `webpieces.config.json` | PASS |
| 3 | `pnpm\|npm install` | ALLOW |
| 4 | `rm -rf node_modules && pnpm install` | ALLOW |
| 5 | `git pull` / `git fetch` — **merge is NOT on the list** | ALLOW |
| 6 | `pnpm exec wp-upgrade-shim` | ALLOW |
| 7 | the `cp` of the shipped template over `.claude/webpieces/ai-hook.sh` | ALLOW |
| 8 | `pnpm exec wp-install-ai-hooks` | ALLOW |

- **PASS** — L0 has no objection; the call falls THROUGH so downstream guards still judge it.
- **ALLOW** — terminal; bypasses everything, because a cure must stay reachable even when a downstream
  guard would block it.

Every Bash entry is anchored to the WHOLE command. A leading `cd <dir> &&`, a trailing `2>&1` and a
pipe into `tail`/`head` are tolerated; nothing else. Appending `&& git status` makes it a DIFFERENT
command and it is rejected again — that is not the guard refusing its own cure.

`git merge` is deliberately absent. Main is merged ONLY through the 3-point fork merge
(`pnpm wp-start-update`, or `pnpm wp-start-upsert-pr` when a PR is already open).

## L0 use cases

| # | case | fault | trigger | cure |
|---|---|---|---|---|
| 1 | pin **newer** than `node_modules` | `D` | pulled/switched to a commit that bumped the pin, before installing | `pnpm install` |
| 2 | pin **older** than `node_modules` | `D` | checkout is behind origin — the *pin* is the stale side | `git pull` **then** `pnpm install`; a bare install would downgrade |
| 3 | bin missing | `X` | fresh clone before install, **or a new `git worktree`** (copies no `node_modules`) — the common way to land here with a perfectly healthy repo | `pnpm install` |
| 4 | bin present but crashed | `K` | corrupt `node_modules`. Captures the first `Cannot find module` line; reports orphaned pnpm staging dirs without auto-cleaning | `rm -rf node_modules && pnpm install` |
| 5 | committed shim != `renderShim()` | `S` | **normal:** an upgrade brought new shim logic. **abnormal:** reverted / hand-edited / tampered | `pnpm exec wp-install-ai-hooks` |
| 6 | `webpieces.config.json` missing | `C` | fresh adoption with hooks wired but no config, or config deleted | `wp-install-ai-hooks`, or just write it — entry 2 always permits that |
| 7 | loaded rule has no config key | `Y` | `node_modules` newer than the config — the one-release-lag trap | add the key (always-allowed write) |
| 8 | **no fault** | — | — | → L1 |
| 9 | fault present **and** call is on the allowlist | — | the entire row 2 of the matrix; what keeps recovery reachable | PASS or ALLOW |
| 10 | fault is `D`/`X`/`K` **and** the call is a Read | — | PASS degenerates to a **terminal allow** — the bin never ran, so there is nothing to fall through to | reads are unguarded during those three |

**Consumers trip `S` on every upgrade that changes shim logic, and must run `pnpm wp-install-ai-hooks`
before continuing. That is the designed inline-upgrade forcing function working, not a regression.**

## Two known gaps

- **`D` is blind to range specs.** Only EXACT pins are compared; `^`, `~`, `workspace:*` are skipped
  ("they never drift"). A consumer pinning with `^` gets no drift protection. `catalog:` was the same
  blindness and caused the 2026-07 `0.3.369 vs 0.4.405` incident — fixed by resolving through
  `pnpm-lock.yaml`. Ranges remain.
- **The `D`/`X`/`K` Read asymmetry** (use case 10). Narrowing the Read entry to a path pattern is the
  fix; deliberately deferred.

## The generated L0 doc

`renderGuardMatrixDoc()` (`core/l0-matrix.ts`) renders the fault table and allowlist **from
`L0_FAULTS` + `L0_ALLOWLIST`** — the same arrays the guard consults — into
`packages/tooling/rules-config/templates/webpieces.guard-matrix.md`, which a unit test locks
byte-identical. That copy cannot describe a guard the code does not implement.

`writeGuardMatrixDoc(workspaceRoot)` drops it into **`<workspaceRoot>/.webpieces/instruct-ai/
webpieces.guard-matrix.md`**, atomically and only when the bytes changed. It is written **lazily, on
an L0 BLOCK only** — two call sites, `hook-core.ts` (fault `S`) and `runner.ts` (fault `C`) — so the
deny can append `READ <path>`. Best-effort: a missing template degrades the deny to no pointer, never
to a crash.

**So: prefer the generated doc for the L0 table and allowlist.** The L0 section above adds the
ordering, the use cases and the gaps, which the generated copy does not carry.

---

# L1 — location

**Code:** `packages/tooling/ai-hook-rules/src/core/effective-tree.ts` (`EffectiveTreeResolver`,
`TreeKind`) · `packages/tooling/ai-hook-rules/src/core/runner.ts` (`gitFromSubdirBlock`,
`filterByExcludedPaths`, the `foreign` check).

L1 answers two questions, and they are genuinely separate:

1. **Do we govern this at all?** — the escape hatches, for other repos and non-governed paths.
2. **Is the agent stranded away from the root?** — force-to-root, git/gh only. Agents forget where
   they are constantly, and `cd` does not persist between tool calls.

## Preamble — resolve the target first (Bash only)

`EffectiveTreeResolver.resolve()` computes `effectiveCwd`: the directory the command actually runs in,
which is the shell's cwd unless the command leads with `cd <dir> &&`. **K is classified from
`effectiveCwd`, not from the shell's cwd** — so "a foreign repo that `cd`s into ours" is not a cell,
it is simply `pw` after resolution.

Only a LEADING run of `cd`/`pushd` counts. A *trailing* `… && cd <exempt-tree>` must never
retroactively pull a command out of scope — that would smuggle a root-level `git push` past the
guards. Quoting is handled by `ShellSegmentScan`, so `echo "cd sub && git push"` is one opaque
segment and its quoted `cd` is never picked up.

## Filter — not a dimension (all tools)

`filterByExcludedPaths` drops every rule excluded for this path: the **target path** for
Read/Write/Edit, `effectiveCwd` for Bash. An empty rule list means allow. This is a filter, not a row:
"exempt" is what emerges when the list empties.

`excludePaths` is **ONE glob list** (canonical: `"excludePaths": ["repositories/**"]`). The
`{ rules: [...], guards: [...] }` object is **retired and rejected**, with the union it must become
named in the error. `wp-install-ai-hooks --sync` migrates it in place.

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
| **K** | tree kind of the resolved target | `f` foreign repo · `o` outside any repo · `pw` ours (primary **or** worktree) |
| **G** | command invokes git/gh | `n` · `y` |
| **P** | position of the resolved target | `root` · `sub` |

All three are **Bash only**. Read/Write/Edit resolve their own target (`input.filePath`) and have no
dimensions — the filter is all that applies to them.

A linked worktree is deliberately **not** foreign: it is the same project, so the guards run against
THAT tree's branch and cache. `p` and `w` are never distinguished, hence `pw`.

## Table

| # | K | G | P | act | why |
|---|---|---|---|---|---|
| 1 | `f` | - | - | 2 exempt | different git repo — hands off |
| 2 | `o` | - | - | → L2 | see "Not done" below |
| 3 | `pw` | `n` | - | → L2 | force-to-root has no jurisdiction |
| 4 | `pw` | `y` | `sub` | 4 block | `cd <root> && <original>` |
| 5 | `pw` | `y` | `root` | → L2 | |

## L1 use cases

| # | command / action | K | G | P | row | verdict |
|---|---|---|---|---|---|---|
| 1 | `cd repositories/vendored && git commit` | `f` | `y` | - | 1 | exempt — jurisdiction judged on the resolved target, after the `cd` |
| 2 | Edit `repositories/vendored/foo.ts` on stale main | — | — | — | filter | exempt — excluded path, guards dropped |
| 3 | Edit `packages/http/foo.ts` on stale main | — | — | — | filter | → L2 → blocked (write on main) |
| 4 | Edit `packages/http/foo.ts`, shell in `/tmp` | — | — | — | filter | judged on the target path — cwd is irrelevant for file tools |
| 5 | `ls` from `packages/http/` | `pw` | `n` | - | 3 | → L2 |
| 6 | `pnpm test` from `packages/http/` | `pw` | `n` | - | 3 | → L2 — untouched |
| 7 | `git status` from `packages/http/` | `pw` | `y` | `sub` | 4 | block → `cd <root> && git status` |
| 8 | `cd packages/http && git status` **from the root** | `pw` | `y` | `sub` | 4 | block — same destination, same answer |
| 9 | `cd <root> && git status` from anywhere | `pw` | `y` | `root` | 5 | → L2 — the prescribed cure |
| 10 | `echo "cd sub && git push"` | `pw` | `n` | `root` | 3 | → L2 — the quoted `cd` is not a scope escape |
| 11 | `cd <subdir> && git push` | `pw` | `y` | `sub` | 4 | block by force-to-root, **before** the push guard's gated-flow message. Still blocked; costs one extra turn |

Use case 8 is the one that changed. It used to be ALLOWED, because the predicate was
`shellAtRoot || cdsToRoot` — two variables OR'd, so the same destination got opposite verdicts
depending on where the shell happened to start. It is now one variable, `effectiveCwd === root`.

## Not done — `o` is not exempt yet

Row 2 hands `'outside'` down to L2 rather than exempting it. `'outside'` is produced at
`effective-tree.ts` (`gitRoot === null`) carrying `governedRoot`, and **no code branches on it**, so a
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

# Keeping this honest

The code anchors this file describes. Change any of them and update the matching section here:

| section | file | symbol |
|---|---|---|
| L0 faults, matrix, generated doc | `ai-hook-rules/src/core/l0-matrix.ts` | `L0_FAULTS`, `renderGuardMatrixDoc`, `writeGuardMatrixDoc` |
| L0 allowlist | `ai-hook-rules/src/bin/l0-allowlist.ts` | `L0_ALLOWLIST`, `isAllowed` |
| L0 `S` enforcement | `ai-hook-rules/src/adapters/hook-core.ts` | `enforceCommittedShim`, `shimStaleRecoveryDecision` |
| L0 `D`/`X`/`K` enforcement | `ai-hook-rules/templates/ai-hook.sh` | the pre-binary `sh` block |
| L1 resolver, K | `ai-hook-rules/src/core/effective-tree.ts` | `EffectiveTreeResolver`, `TreeKind` |
| L1 force-to-root | `ai-hook-rules/src/core/runner.ts` | `gitFromSubdirBlock` |
| L1 filter | `ai-hook-rules/src/core/runner.ts` | `filterByExcludedPaths` |
| `excludePaths` shape | `rules-config/src/exclude-hook-paths.ts`, `validate-config.ts` | `ExcludePaths`, `validateExcludePaths` |
