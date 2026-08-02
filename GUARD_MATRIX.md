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
| 8 | `pnpm exec wp-install-ai-hooks` — **flags allowed**, e.g. `--target=project` | ALLOW |

- **PASS** — L0 has no objection; the call falls THROUGH so downstream guards still judge it.
- **ALLOW** — terminal; bypasses everything, because a cure must stay reachable even when a downstream
  guard would block it.

Every Bash entry is anchored to the WHOLE command. A leading `cd <dir> &&`, a trailing `2>&1` and a
pipe into `tail`/`head` are tolerated; nothing else. Appending `&& git status` makes it a DIFFERENT
command and it is rejected again — that is not the guard refusing its own cure.

`git merge` is deliberately absent. Main is merged ONLY through the 3-point fork merge
(`pnpm wp-start-update`, or `pnpm wp-start-upsert-pr` when a PR is already open).

## The config-validation invariant — every config problem cures to ONE action

**Every problem with `webpieces.config.json` — a validation error, a syntax error, or the file being
absent — has exactly one cure: MAKE THE FILE RIGHT. Edit it (or create it) so the reported errors go
away.** There is no class of config problem cured by running something else first.

This is not a style preference, it is forced by the code, and it is written down here because an
ordered list of general advice is how an AI picks the wrong step. It has already happened: an agent
read a 4-step "FIX ORDER", skipped to step 4, and chased a command that was itself blocked, while
step 3 — edit the file — was the whole answer.

Why every other candidate cure is disqualified as the primary instruction:

- **`pnpm install` can never be the cure.** `templates/ai-hook.sh` gates the guard bin on
  `[ -x "$BIN" ] && [ -z "$DRIFT_PKG" ]`, and `DRIFT_PKG` is set by comparing every exact-pinned
  `@webpieces/*` in root `package.json` against the installed version (`catalog:` specs resolved
  through `pnpm-lock.yaml` first). So the validator only ever RUNS when `package.json` and
  `node_modules` already agree — meaning that whenever you are reading a config validation error,
  there is provably nothing for an install to bring into sync. *Sole caveat:* the drift check skips
  range specs (`^`, `~`, `workspace:*` hit `*) continue ;;`), so a repo pinning with ranges is outside
  this guarantee. This repo pins exactly — `validate-versions-locked` enforces it.
- **There is no installer spelling in this cure at all** (2026-08-02). A "migrate my config" flag used
  to be offered here as an optional bulk editor. It is DELETED: `migrate()` is not surgical (it
  rewrites the whole file, appends every missing built-in at its `recommendedSeedMode()` — enforcing,
  not `OFF` — and reformats), so its diff is far
  larger than the error being fixed — and offering a second command at all is what makes an agent
  believe the one stated cure is a choice. The banner now names no installer command, for one error or
  twenty.
- **Bumping the `@webpieces` pin** is a secondary *check*, not a step: relevant only when the config
  was deliberately written for a newer release than `package.json` pins (e.g. a key copied out of
  newer docs). Then the fix is bump-then-install — never a bare install.

So the guidance an agent is handed must be: *fix each bullet by editing `webpieces.config.json`;
editing it is allowed even right now while it is invalid.* Plus the two negatives, which carry as much
weight as the positive: **do not run `pnpm install`** (it cannot help), and **do not delete a key just
because it is unknown** (first check whether the pin is older than the config expects).

### Fault `C` (no config at all) is the same invariant — write the file

A valid config must carry every built-in rule with its required fields, so "just write it" looks
daunting. It is not, because **the validator reports every error at once** — like a compiler printing
ten errors, not one. So the loop converges in a couple of passes: write a minimal file, get back the
full list of what is missing (each with its copy-paste snippet), fix them all in one edit. That is the
intended flow, and it is why nothing needs to seed the file for you.

Which matters, because neither installer spelling is a clean fit here anyway:

| command | on a missing config |
|---|---|
| bare `pnpm wp-install-ai-hooks` | seeds it, then PROMPTS twice (`wireHook` ×2) — hangs a non-interactive agent |
| `pnpm wp-install-ai-hooks --target=<x>` | seeds it, but also re-points the hooks — which are already wired, or `C` would not have fired |

`CONFIG_MISSING_REPORT` led with the bare form — i.e. the one that prompts, which stalls a
non-interactive agent. Fault `C`'s reliable answer is its Option 2 — write the file yourself, which
allowlist entry 2 always permits — and let the aggregated error list drive the remaining passes. What
SHOULD change is the message's ordering: Option 2 is the agent-safe one and should lead.

**Done (2026-08-02).** That ordering is now the shipped one: `CONFIG_MISSING_REPORT` leads with "create
the file yourself", and the bare installer is Option 2, carrying the condition under which it is safe
(an interactive terminal).

## L0 use cases

Every row encodes a real incident. The **Fix** column is deliberately LITERAL — a command you can
copy, never a description of one — because prose is what let an agent read "sync the config" and
invent a spelling the allowlist rejected. Where two options exist, the discriminator says which is
yours; where a specific wrong turn exists, it is named.

The per-fault Fix column is also rendered from code, from `L0_FAULTS[].cures`, into
`webpieces.guard-matrix.md` (see "The generated L0 doc"). **That generated copy is the authority** —
this table adds the symptom and the incident, not a second set of commands.

| # | what you SEE (exact symptom) | state | verdict | Fix |
|---|---|---|---|---|
| 1 | `version drift: package.json pins …@X but node_modules has Y`, where **X > Y** | `D`; you pulled or switched to a commit that bumped the pin, before installing | BLOCK | Option 1 (preferred): `pnpm install` |
| 2 | same message, but **X < Y** — the *pin* is the stale side (your checkout is behind origin) | `D`; on **main** | BLOCK | Option 1 (preferred): `git pull origin main`, then `pnpm install`<br>Option 2: check out the commit you want, branch from it, then `pnpm install` ← pick this when you deliberately want to stay on the OLD code; the downgrade is the point<br>Do NOT: a *bare* `pnpm install` on main — it clears the block but downgrades you |
| 3 | same message, **X < Y**, on a **feature branch** | `D`; your branch pins its own version | BLOCK | Option 1 (preferred): `pnpm install` ← aligns node_modules to YOUR branch's pin, which is usually what you want<br>Option 2: `pnpm install` FIRST (that re-arms the guards), THEN `pnpm wp-start-update` ← pick this when you actually want main's newer @webpieces<br>Do NOT: run `pnpm wp-start-update` while the block is up — it is not on the allowlist and does not need to be |
| 4 | `…-hook not found` / `is declared in package.json but is not installed` | `X`; fresh clone before install, **or a new `git worktree`** — git copies no `node_modules`, so this is the common way to land here with a perfectly healthy repo | BLOCK | Option 1 (preferred): `pnpm install` ← run it **HERE**, in this worktree; installing in the primary clone does nothing for this tree |
| 5 | `installed but CRASHED (Cannot find module …)`, often with a count of orphaned pnpm staging dirs | `K`; corrupt / partially-written `node_modules` (an install that was killed) | BLOCK | Option 1 (preferred): `rm -rf node_modules && pnpm install` ← a *bare* install SKIPS the corrupt package: pnpm sees the right version on disk and considers it installed<br>Do NOT: `pnpm install` on its own |
| 6 | `.claude/webpieces/ai-hook.sh no longer matches the ai-hook.sh rendered by the INSTALLED @webpieces` | `S`; **normal:** an upgrade brought new shim logic. **abnormal:** reverted / hand-edited / tampered | BLOCK | Option 1 (preferred): `pnpm exec wp-upgrade-shim` ← the SURGICAL tool: it regenerates the shim and touches nothing else — no config, no settings.json — and imports only fs/path, so it runs on a broken tree (needs 0.4.408+)<br>Option 2: `cp node_modules/@webpieces/ai-hook-rules/templates/ai-hook.sh .claude/webpieces/ai-hook.sh` ← pick this when the installed release is older than 0.4.408, where `wp-upgrade-shim` does not exist yet (that gap caused a real "command not found" deadlock, 2026-07-21); Claude Code's own permission prompt may ask you to confirm the overwrite, and that prompt is NOT this guard<br>Do NOT: `pnpm exec wp-install-ai-hooks` — this fault is shim-only, and the installer also migrates your config and wires both hooks, prompting twice, which hangs a non-interactive agent |
| 7 | **any** complaint about `webpieces.config.json`: `not found` (`C`), `is out of sync` (`Y`), an N-error validation banner, or a parse error | `C`/`Y`/validation/syntax — one class, not four | BLOCK | Option 1 (preferred): edit `webpieces.config.json` so the reported errors go away — see "The config-validation invariant" above; that section is the authority and this row does not re-derive it<br>Do NOT: `pnpm install` (cannot help), and do NOT delete an unknown key on sight |
| 8 | nothing — no fault | — | → L1 | — |
| 9 | your cure is allowed through while everything else is denied | any fault, call on the allowlist | PASS or ALLOW | this is row 2 of the matrix, and it is what keeps recovery reachable — run the cure yourself |
| 10 | Reads succeed while `D`/`X`/`K` blocks Bash | the bin never ran, so PASS degenerates to a **terminal allow** | ALLOW_FAIL_OPEN | nothing to do — but note reads are UNGUARDED during those three (see "Two known gaps") |

Row 7 is the collapse: `C`, `Y`, a validation banner and a syntax error look like four problems and
are one. They all mean the file is wrong, and they all cure to making it right.

**Consumers trip `S` on every upgrade that changes shim logic, and must run
`pnpm exec wp-upgrade-shim` before continuing. That is the designed inline-upgrade forcing
function working, not a regression.**

## Two known gaps

- **`D` is blind to range specs.** Only EXACT pins are compared; `^`, `~`, `workspace:*` are skipped
  ("they never drift"). A consumer pinning with `^` gets no drift protection. `catalog:` was the same
  blindness and caused the 2026-07 `0.3.369 vs 0.4.405` incident — fixed by resolving through
  `pnpm-lock.yaml`. Ranges remain.
- **The `D`/`X`/`K` Read asymmetry** (use case 10). Narrowing the Read entry to a path pattern is the
  fix; deliberately deferred.

## The generated L0 doc

`renderGuardMatrixDoc()` (`core/l0-matrix.ts`) renders the fault table, the **per-fault Fix sections**
and the allowlist **from `L0_FAULTS` + `L0_ALLOWLIST`** — the same arrays the guard consults — into
`packages/tooling/rules-config/templates/webpieces.guard-matrix.md`, which a unit test locks
byte-identical. That copy cannot describe a guard the code does not implement.

`writeGuardMatrixDoc(workspaceRoot)` drops it into **`<workspaceRoot>/.webpieces/instruct-ai/
webpieces.guard-matrix.md`**, atomically and only when the bytes changed. It is written **lazily, on
an L0 BLOCK only** — two call sites, `hook-core.ts` (fault `S`) and `runner.ts` (fault `C`) — so the
deny can append `READ <path>`. Best-effort: a missing template degrades the deny to no pointer, never
to a crash.

The Fix sections come from `L0_FAULTS[].cures`, where each `L0Cure` carries the exact call, a
`preferred` flag (exactly one per fault) and a `discriminator` — the sentence saying WHEN to pick a
sibling instead. Two assertions in `l0-matrix.spec.ts` keep that honest: every cure must be accepted by
`isAllowed()` AND named in its fault's deny text, and — scraping the RENDERED output, not the array —
**every command printed in any Fix section must pass `isAllowed()`**. That second one is the assertion
that would have caught a FLAGGED `pnpm wp-install-ai-hooks` being prescribed by config messages while
the installer allowlist entry accepted no flags at all.

**So: prefer the generated doc for the L0 table, the Fix sections and the allowlist.** The L0 section
above adds the ordering, the symptoms/incidents and the gaps, which the generated copy does not carry.

---

# L1 — location

**Code:** `packages/tooling/ai-hook-rules/src/core/effective-tree.ts` (`EffectiveTreeResolver`,
`TreeKind`) · `packages/tooling/ai-hook-rules/src/core/runner.ts` (`gitFromSubdirBlock`,
`filterByExcludedPaths`, the `foreign` check).

L1 answers two questions, and they are genuinely separate:

1. **Do we govern this at all?** — the escape hatches, for other repos and non-governed paths.
2. **Is the agent stranded away from the root?** — force-to-root, git/gh only. Agents forget where
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

Same row shape as L0: the **Fix** is literal or it is not a fix. `<root>` is the absolute workspace
root — the messages name it explicitly rather than telling you to `cd` first, for the reason in the
section head (neither the shell's cwd nor a `cd`'s persistence can be assumed).

| # | what you SEE (exact symptom) | state (K/G/P) | verdict | Fix |
|---|---|---|---|---|
| 1 | `cd repositories/vendored && git commit` goes through untouched | `f` / `y` / - — row 1 | ALLOW_EXEMPT | none needed — jurisdiction is judged on the RESOLVED target, after the `cd`; a different git repo is hands-off |
| 2 | Edit `repositories/vendored/foo.ts` allowed even on stale main | filter — the path is in `excludePaths` | ALLOW_EXEMPT | none needed |
| 3 | Edit `packages/http/foo.ts` blocked on stale main | filter keeps the rules → L2 fires | BLOCK (at L2) | that is L2's write-on-main verdict, not L1's — follow the L2 message |
| 4 | Edit `packages/http/foo.ts` judged even though the shell is in `/tmp` | filter, on the TARGET path | → L2 | none — for file tools the cwd is irrelevant; do NOT `cd` anywhere to "fix" it |
| 5 | `ls` from `packages/http/` runs normally | `pw` / `n` / - — row 3 | → L2 | none — force-to-root has no jurisdiction over non-git commands |
| 6 | `pnpm test` from `packages/http/` runs normally | `pw` / `n` / - — row 3 | → L2 | none — deliberately untouched, so package-local test runs stay natural |
| 7 | `git status` from `packages/http/` is blocked | `pw` / `y` / `sub` — row 4 | BLOCK | Option 1 (preferred): `cd <root> && git status` |
| 8 | `cd packages/http && git status` **typed from the root** is blocked | `pw` / `y` / `sub` — row 4 | BLOCK | Option 1 (preferred): `cd <root> && git status`<br>Do NOT: assume it is allowed because you started at the root — the predicate is `effectiveCwd === root`, i.e. the DESTINATION |
| 9 | `cd <root> && git status` passes from anywhere | `pw` / `y` / `root` — row 5 | → L2 | none — this IS the prescribed cure |
| 10 | `echo "cd sub && git push"` passes | `pw` / `n` / `root` — row 3 | → L2 | none — the `cd` is inside quotes, so `ShellSegmentScan` never treats it as a scope escape |
| 11 | `cd <subdir> && git push` blocked with the force-to-root message, NOT the gated-flow one | `pw` / `y` / `sub` — row 4; force-to-root runs first | BLOCK | Option 1 (preferred): `cd <root> && git push`, which then gets the push guard's real answer ← costs one extra turn by design; still blocked |

Row 8 is the one that changed. It used to be ALLOWED, because the predicate was
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
