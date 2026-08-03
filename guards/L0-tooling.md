# L0 — tooling integrity

**Goal: is webpieces itself trustworthy right now?**

**Config key: none — L0 is always on.** If L0 could be switched off you would be configuring the guards
with a config file the validator could not check.


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
| 9 | read-only **orientation**: `pwd`, `git status\|log\|diff\|show\|branch\|rev-parse`, `git worktree list` | ALLOW |

Entry 9 is the only one that is not a cure — it is the DIAGNOSIS the cures depend on. An agent in a
linked worktree, blocked by a `D` measured against the primary clone, ran `pnpm install` five times
because it could not run `pwd` to see that it was standing somewhere else (2026-08-03). Only the
literal `list` subcommand of `git worktree` is accepted; `add` / `remove` / `prune` / `move` /
`repair` all mutate and stay denied, as does a bare `git worktree`.

Being a diagnostic rather than a cure also means entry 9 does **not** bypass L1. The other Bash
entries repair the tooling, so they are waved through ahead of the config load — unconditionally, on a
healthy repo too (`L0_CURE_ALLOW_JS`). Orientation repairs nothing, so on a healthy repo `git status`
from a subdirectory still meets L1's force-to-root; it is only exempt while a fault is up. That
`cure` flag on `L0AllowEntry` is the ONLY per-entry variation in the list, and it decides nothing
about L0 — under a fault every entry is judged identically.

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
| 11 | you are blocked in a **linked worktree** and `pnpm install` keeps succeeding without clearing it | any fault, measured against `$CLAUDE_PROJECT_DIR` (the **primary clone**) while you stand somewhere else | BLOCK, then ALLOW once you look | Option 1 (preferred): `pwd` ← allowlist entry 9; then compare it with the path the deny names. Fix the tree you are actually IN with `cd <that path> && pnpm install`.<br>Also allowed: `git worktree list`, `git rev-parse --show-toplevel`<br>Do NOT: re-run the same bare `pnpm install` a second time — it already succeeded, in the wrong tree (2026-08-03: five identical installs, then the block was handed back to the human) |

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
  fix; deliberately deferred. Allowlist entry 9 (read-only orientation) sits in the same asymmetry: the
  bin never runs under those three, so an allowed `git status` is terminal rather than falling through
  to L1. It reads and reports only, so the exposure is disclosure, not mutation — but it is the same
  gap, and the same narrowing closes both.

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


## Worked example — the two faults fire in sequence on an upgrade

Observed live. `main` bumps the `@webpieces` pin to a newly published release:

1. Next tool call → **`D`**: "pins `0.4.545` but node_modules has `0.4.526`". Cure: `pnpm install`.
2. Next tool call → **`S`**: the committed shim was rendered by `0.4.526` and no longer matches
   `0.4.545`'s `renderShim()`. Cure: `pnpm exec wp-upgrade-shim`.
3. Guards re-armed.

Two blocks, two one-line cures, no deadlock. Note the trap in step 2: the shim that matters is the one
`settings.json` points at — `$CLAUDE_PROJECT_DIR/.claude/webpieces/ai-hook.sh`, i.e. **the primary
clone**. Regenerating it inside a linked worktree re-arms the wrong copy and the fault keeps firing.

## Code anchors

| section | file | symbol |
|---|---|---|
| faults, matrix, generated doc | `ai-hook-rules/src/core/l0-matrix.ts` | `L0_FAULTS`, `renderGuardMatrixDoc`, `writeGuardMatrixDoc` |
| the allowlist | `ai-hook-rules/src/bin/l0-allowlist.ts` | `L0_ALLOWLIST`, `isAllowed` |
| `S` enforcement | `ai-hook-rules/src/adapters/hook-core.ts` | `enforceCommittedShim`, `shimStaleRecoveryDecision` |
| `D`/`X`/`K` enforcement | `ai-hook-rules/templates/ai-hook.sh` | the pre-binary `sh` block |
