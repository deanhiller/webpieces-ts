# L0 — tooling integrity

**Goal: is webpieces itself trustworthy right now?**

**Config key: none — L0 is always on.** If L0 could be switched off you would be configuring the guards
with a config file the validator could not check.

L0 blocks work while `node_modules`, the committed shim, or `webpieces.config.json` are in a state
that makes every other guard untrustworthy.

**HOW TO READ THIS FILE.** The next section is GENERATED from the arrays the guard consults — the
faults, their cures, the matrix, the allowlist, the managed surfaces and the audit-line fields. It is
what you want if you are blocked right now. Everything after it is hand-written: incidents, arguments
and known gaps, which is the half a renderer would mangle. The markers say which is which, and nothing
outside them is machine-owned.

<!-- BEGIN GENERATED — L0ToolingDoc.render() in ai-hook-rules/src/core/l0-tooling-doc.ts; run `pnpm guards:generate` -->
> **GENERATED — do not hand-edit between the markers.** Rendered by `L0ToolingDoc.render()`
> (`ai-hook-rules/src/core/l0-tooling-doc.ts`) from `L0_FAULTS`, `L0_ALLOWLIST`, the managed-surface
> constants and `SHIM_LOG_FIELDS` — the same arrays the guard consults. `pnpm guards:generate`
> rewrites it; `l0-tooling-doc.spec.ts` locks it byte-for-byte. The prose outside the markers is
> hand-written and stays that way.

### The faults

| code | guard name | fault | detected by | enforced in |
|---|---|---|---|---|
| `D` | `version-drift` | version drift — root package.json pin != installed version | sh, before the bin runs | sh |
| `X` | `guard-bin-missing` | guard bin missing (fresh clone / new worktree / package removed) | sh, before the bin runs | sh |
| `U` | `guard-pkg-undeclared` | guard bin missing AND @webpieces/ai-hook-rules is not declared in package.json | sh, before the bin runs | sh |
| `K` | `guard-bin-crashed` | guard bin present but CRASHED (exit code not 0 or 2 — corrupt node_modules) | sh, before the bin runs | sh |
| `S` | `managed-hook-surface` | a webpieces-managed hook file, the .claude/settings.json registration or its managed env entry does not match this release | the guard bin | JS |
| `C` | `config-missing` | webpieces.config.json missing | the guard bin | JS |
| `Y` | `config-out-of-sync` | a loaded rule has no webpieces.config.json key | the guard bin | JS |

First match wins. `D`/`X`/`U`/`K` are decided in POSIX `sh` inside the committed shim, BEFORE
the guard bin runs — a stale, missing or broken validator cannot be trusted to validate itself.
`S`/`C`/`Y` are decided inside the bin, in JS.

### The fix, per fault — type the option EXACTLY as written, and run nothing else on that line

| fault | option | run EXACTLY | pick this when |
|---|---|---|---|
| `D` | 1 (preferred) | `pnpm install` | node_modules is OLDER than the pin, OR you are on a feature branch and want YOUR branch pin (usually the case) — it always clears the drift |
| `D` | 2 | `git checkout main && git pull origin main` | node_modules is NEWER than the pin AND you are on main — the PIN is the stale side, so sync first and install second; a bare install would downgrade you |
| `X` | 1 (preferred) | `pnpm install` | this fault fires at all — nothing is installed in THIS tree, and a new git worktree copies no node_modules |
| `U` | 1 (preferred) | `pnpm add -D @webpieces/ai-hook-rules` | this fault fires at all — package.json asks for nothing, so pnpm install reports "Lockfile is up to date" and leaves the tree exactly as broken as it found it |
| `K` | 1 (preferred) | `rm -rf node_modules && pnpm install` | this fault fires at all — a BARE pnpm install SKIPS the corrupt package, because pnpm sees the right version on disk and considers it installed; only the delete forces a rewrite |
| `S` | 1 (preferred) | `pnpm exec wp-upgrade-shim` | this fault fires at all — it is the only cure that repairs all three managed things (ai-hook.sh, the settings.json registration and its managed env entry), and it also deletes the retired guarantee-root.sh and any entry still naming it, and it touches no config; needs installed @webpieces/ai-hook-rules 0.4.408 or newer |
| `S` | 2 | `cp node_modules/@webpieces/ai-hook-rules/templates/ai-hook.sh .claude/webpieces/ai-hook.sh` | the installed @webpieces/ai-hook-rules is OLDER than 0.4.408, so wp-upgrade-shim does not exist yet — it is PARTIAL (it repairs ai-hook.sh and NOTHING else), so upgrade @webpieces afterwards and run Option 1 to finish |
| `C` | 1 (preferred) | edit `webpieces.config.json` yourself | this fault fires at all — it is the only cure that needs no other tool, and it is never denied |
| `C` | 2 | `pnpm exec wp-install-ai-hooks` | you are at an INTERACTIVE terminal and can answer its two hook-target prompts |
| `Y` | 1 (preferred) | edit `webpieces.config.json` yourself | this fault fires at all — it is the only cure that needs no other tool, and it is never denied |

### The matrix — three rows, and the fault only picks the MESSAGE

| row | fault | on the allowlist? | outcome | logged as |
|---|---|---|---|---|
| 1 | none | — | hand down to the next guard layer | `layer=L0 row=1` |
| 2 | any | yes | PASS or ALLOW (see the entry) | `layer=L0 row=2` |
| 3 | any | no | BLOCK — **only the message varies by fault** | `layer=L0 row=3` |

The tool is not a dimension either: "any Read" is an allowlist ENTRY, not a tool check. Those are
the same coordinates every L0 deny opens with, so a deny, a log line and this table join by eye.

### The allowlist — ONE list, consulted identically by every fault

| # | allowed | outcome | bypasses L1 on a HEALTHY tree? |
|---|---|---|---|
| 1 | any Read | PASS | no — it repairs nothing, so L1 still judges it |
| 2 | a Write/Edit whose target is webpieces.config.json | PASS | no — it repairs nothing, so L1 still judges it |
| 3 | a Write/Edit whose target is a tree ROOT's pnpm-workspace.yaml or package.json - the version pin | PASS | no — it repairs nothing, so L1 still judges it |
| 4 | pnpm\|npm install | ALLOW | yes — it REPAIRS the tooling |
| 5 | rm -rf node_modules && pnpm install - the cure for a CORRUPT node_modules | ALLOW | yes — it REPAIRS the tooling |
| 6 | git fetch - a bare git pull and git merge are NOT on the list | ALLOW | yes — it REPAIRS the tooling |
| 7 | git checkout main && git pull origin main | ALLOW | yes — it REPAIRS the tooling |
| 8 | pnpm exec wp-upgrade-shim | ALLOW | yes — it REPAIRS the tooling |
| 9 | cp node_modules/@webpieces/ai-hook-rules/templates/ai-hook.sh .claude/webpieces/ai-hook.sh | ALLOW | yes — it REPAIRS the tooling |
| 10 | pnpm wp-prune-unknown-config | ALLOW | yes — it REPAIRS the tooling |
| 11 | pnpm exec wp-install-ai-hooks (flags allowed, e.g. --target=project) | ALLOW | yes — it REPAIRS the tooling |
| 12 | pnpm add -D @webpieces/ai-hook-rules (an @version and extra flags allowed) | ALLOW | yes — it REPAIRS the tooling |
| 13 | read-only orientation: pwd, git status/log/diff/show/branch/rev-parse, git worktree list | ALLOW | no — it repairs nothing, so L1 still judges it |

- **PASS** — L0 has no objection; the call falls THROUGH so downstream guards still judge it.
- **ALLOW** — terminal; bypasses everything, because a cure must stay reachable even when a
  downstream guard would block it.

Every Bash entry is anchored to the WHOLE command. A leading `cd <dir> &&`, a trailing `2>&1` and a
pipe into `tail`/`head` are tolerated; nothing else. Appending `&& git status` makes it a DIFFERENT
command and it is rejected again — that is not the guard refusing its own cure.

`git merge` and a **bare** `git pull` are both deliberately absent — see "The git-sync split"
below for why the one safe pull spelling is on the list and the bare one is not. Main is merged
ONLY through the 3-point fork merge (`pnpm wp-start-update`, or `pnpm wp-start-upsert-pr` when a
PR is already open).

### The managed hook surface — what fault `S` compares (THREE things, one set)

| # | surface |
|---|---|
| 1 | `.claude/webpieces/ai-hook.sh` |
| 2 | .claude/settings.json hook registration |
| 3 | .claude/settings.json env.CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR |

The registration is TWO PreToolUse entries, and both are ABSOLUTE — they resolve from any cwd:

```
sh "$CLAUDE_PROJECT_DIR/.claude/webpieces/ai-hook.sh" wp-ai-guards-hook
sh "$CLAUDE_PROJECT_DIR/.claude/webpieces/ai-hook.sh" wp-ai-rules-hook
```

`pnpm exec wp-upgrade-shim` repairs all three. `cp node_modules/@webpieces/ai-hook-rules/templates/ai-hook.sh .claude/webpieces/ai-hook.sh`
repairs `.claude/webpieces/ai-hook.sh` and nothing else, so it is the fallback for an installed release too old
to carry the first.

### The L0 audit line — one tab-separated line per tool call

```
<iso-ts>  <bin-name>  <tool>  tree=<name|primary>  layer=L0  row=<1|2|3>  shim=<root>  [bin=<root>]  fault=<D|X|U|K|->  <VERDICT>  <command>
```

| # | field | means |
|---|---|---|
| 1 | `<iso-ts>` | when the shim judged the call, local time with offset |
| 2 | `<bin-name>` | WHICH hook ran - wp-ai-guards-hook or wp-ai-rules-hook; Claude Code runs them in parallel |
| 3 | `<tool>` | the PreToolUse tool name (Bash, Read, Write, Edit, …) |
| 4 | `tree=<name\|primary>` | git's own name for the worktree the CALL was made in, derived from the payload's cwd |
| 5 | `layer=L0` | the layer that judged it — constant here, and the first half of the join key a deny cites |
| 6 | `row=<1\|2\|3>` | WHICH row of the three-row matrix this call took, read off the verdict (hand-down / allowlisted / blocked) |
| 7 | `shim=<root>` | WHICH COPY of ai-hook.sh ran, resolved from $0 — against tree= it is the straddle detector |
| 8 | `bin=<root>` | WHICH TREE supplied the binary — printed ONLY when it differs from shim=, so its presence IS the borrow |
| 9 | `fault=<D\|X\|U\|K\|->` | the sh-side L0 fault, or `-`; S/C/Y are the binary's and are stamped on ITS streams |
| 10 | `<VERDICT>` | one of the verdict labels below — kept adjacent to the command |
| 11 | `<command>` | the command PREFIX (the audit spelling; the DECISION reads $CMD, which fails closed on a quote) |

| verdict | means |
|---|---|
| `PASS-BIN-ALLOW` | no sh-side fault; the bin ran and exited 0 — matrix row 1, handed down to L1 |
| `PASS-BIN-BLOCK` | no sh-side fault; the bin ran and exited 2 — matrix row 1, a LATER layer blocked |
| `ALLOW-READ` | allowlist entry 1 (any Read) — PASS, but terminal here (the bin never ran) |
| `ALLOW-CONFIG` | allowlist entry 2 (a Write/Edit of webpieces.config.json) — PASS, terminal here |
| `ALLOW-MANIFEST` | allowlist entry 3 (a Write/Edit of pnpm-workspace.yaml or package.json) — PASS, terminal here |
| `ALLOW-CURE` | a Bash entry of the allowlist matched — ALLOW |
| `DENY` | fault X, not on the allowlist — BLOCK_AI_CURE |
| `DENY-UNDECLARED` | fault U, not on the allowlist — BLOCK_AI_CURE |
| `DENY-STALE` | fault D, not on the allowlist — BLOCK_AI_CURE |
| `DENY-BROKEN` | fault K, not on the allowlist — BLOCK_AI_CURE |

It lands in the log directory of the tree the CALL was made in, centralized under the primary clone
so that removing a worktree does not take its audit trail with it:

```
<primary>/.webpieces/worktrees/<tree>/logs/L0-shim/<session>-<agent|coordinator>-<binName>.log
<primary>/.webpieces/logs/L0-shim/<session>-<agent|coordinator>-<binName>.log   # from the primary clone itself
```

The binary stamps the same `layer=`/`row=`/`fault=` fields onto its OWN streams —
`L1-location/`, `L2-decisions/`, `calls/` and `rejections/` under the same
`logs/` — so one grep spans the whole trail. A `webpieces.config.json` fault (`C`/`Y`) is
therefore visible there and never on an `L0-shim` line, which only ever carries the `sh`-side codes.

<!-- END GENERATED — hand-written prose resumes here -->

## Ordering is real, not just a matrix

- `D` is computed FIRST and gates whether the bin runs at all: `if [ -x "$BIN" ] && [ -z "$DRIFT_PKG" ]`.
  So `D` and `K` are mutually exclusive by construction.
- Fault precedence in `sh` is last-assignment-wins over `X` → `U` → `D` → `K`, i.e. `K` beats `D` beats
  `U` beats `X`. The verdict label follows the same order (`DENY-BROKEN` / `DENY-STALE` /
  `DENY-UNDECLARED` / `DENY`).
- `U` is `X` with the ONE input that INVERTS `X`'s cure: when nothing declares `@webpieces/ai-hook-rules`,
  `pnpm install` is not a weaker fix, it is a provable no-op. That is why it is its own fault and not a
  sentence inside `X`'s message.
- JS side: `enforceCommittedShim` runs before the Read/Bash/Edit dispatch, so `S` precedes `C` and `Y`.
- **`Y` is NOT outermost.** On the Bash path `checkConfigSync` runs *after* L1's foreign check and
  `excludePaths` filter. That is deliberate — do not demand a config key for a rule that was excluded
  anyway — but it means "L0 is the outermost layer" is not literally true for `Y`.

## Why the allowlist is ONE list, and what the `cure` flag decides

A cure that cannot help a given fault also cannot hurt it, and gating each entry on a fault is what
produced four real defects: under `S`, `pnpm install` was denied (so every permitted cure wrote the OLD
binary's `renderShim()` over a NEWER committed shim, silently reverting a commit); under `S`, every git
sync was denied, which is the only cure when the CHECKOUT is the stale side; under `D`/`X`/`K`, every
Read was denied, leaving no way to inspect even the config that disables the rule; and under `C`/`Y`,
`rm -rf node_modules && pnpm install` was denied while a bare `pnpm install` passed.

### The git-sync split — one decision, two entries (2026-08-10, audit finding C6)

`git pull` used to share the `git fetch` entry and was TERMINAL, so it short-circuited
`redirect-how-to-merge-main` — the guard whose entire job is stopping `git pull origin main` on a
FEATURE branch, because a raw pull there merges main into the branch and destroys the fork point that
the 3-point merge, `nx affected --base=` and the PR review diff are all computed from. Under an L0 fault
the drift message *told* the agent to run it and the allowlist *permitted* it, on whatever branch it
happened to be on; nothing failed at the time, and it surfaced later as a build that covered the wrong
scope and a PR diff describing work nobody did.

So the entry was split, and the generated table above shows both halves:

- **`git fetch`** cannot merge, so it can never poison a fork point, and it stays terminal.
- **`git checkout main && git pull origin main`** is the one pull spelling that is always safe — it ends
  ON main, so nothing is merged into a feature branch, and it is a no-op checkout when you are already
  there. It is byte-for-byte what `stale-main-bash-guard` already calls its preferred cure.

Any other branch (`git checkout feat && git pull origin main`) is REFUSED, and a **bare** `git pull` is
no longer on the list at all: it falls through to `redirect-how-to-merge-main`, which allows it on main
and blocks it on a feature branch. `git merge` was never on the list and still is not.

The **read-only orientation** entry is the only one that is not a cure — it is the DIAGNOSIS the cures
depend on. An agent in a linked worktree, blocked by a `D` measured against another tree, ran
`pnpm install` five times because it could not run `pwd` to see that it was standing somewhere else
(2026-08-03). Only the literal `list` subcommand of `git worktree` is accepted; `add` / `remove` /
`prune` / `move` / `repair` all mutate and stay denied, as does a bare `git worktree`.

Being a diagnostic rather than a cure is also why it does **not** bypass L1. The other Bash entries
repair the tooling, so they are waved through ahead of the config load — unconditionally, on a healthy
repo too (`L0_CURE_ALLOW_JS`). Orientation repairs nothing, so on a healthy repo `git status` from a
subdirectory still meets L1's force-to-root; it is exempt only while a fault is up. That `cure` flag on
`L0AllowEntry` is the ONLY per-entry variation in the list, and it decides nothing about L0 — under a
fault every entry is judged identically. It is the last column of the generated allowlist table above.

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
  not `OFF` — and reformats), so its diff is far larger than the error being fixed — and offering a
  second command at all is what makes an agent believe the one stated cure is a choice. The banner now
  names no installer command, for one error or twenty.
- **An UNKNOWN key is DELETED, and that is not a caveat to the rule — it IS making the file right.**
  A key the running validator has no schema for controls NOTHING, and when the key is retired, deletion
  is the whole fix. `pnpm wp-prune-unknown-config` (an allowlist entry, so it runs from inside the
  block) strips every unknown key mechanically, or delete them by hand. This paragraph used to say the
  opposite — "do NOT delete a key just because it is unknown" — which contradicted the banner the reader
  was looking at while reading it.
- **Bumping the `@webpieces` pin** is a rare secondary *check*, never a step: a key can be
  valid-but-unlearned when `package.json` pins an `@webpieces` OLDER than the config was written for.
  You are not in that case when you are reading a validation error, because the version-drift guard
  compares the pin against the installed version BEFORE the validator runs and denies with its own cure.

So the guidance an agent is handed is: *fix each bullet by editing `webpieces.config.json`; editing it
is allowed even right now while it is invalid.* Plus the one negative that carries as much weight as the
positive: **do not run `pnpm install`** — it cannot help.

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
| `pnpm wp-install-ai-hooks --target=project` | seeds it, but also re-points the hooks — which are already wired, or `C` would not have fired |

`CONFIG_MISSING_REPORT` used to lead with the bare form — i.e. the one that prompts, which stalls a
non-interactive agent. Since 2026-08-02 it leads with "create the file yourself", which allowlist entry 2
always permits, and the installer is the second option carrying the condition under which it is safe (an
interactive terminal). That is the ordering the generated fix table above prints.

## L0 use cases

Every row encodes a real incident, and the row exists for what the code CANNOT tell you: the exact
symptom, the state it implies, and the wrong turn that was actually taken. **The commands live in the
generated fix table above** — this table deliberately does not restate them, because a second set of
literals is exactly how a doc comes to prescribe a spelling the allowlist rejects.

| # | what you SEE (exact symptom) | state | verdict | what the code cannot tell you |
|---|---|---|---|---|
| 1 | `version drift: package.json pins …@X but node_modules has Y`, where **X > Y** | `D`; you pulled or switched to a commit that bumped the pin, before installing | BLOCK | the plain case — `D`'s preferred cure is the whole answer |
| 2 | same message, but **X < Y** — the *pin* is the stale side (your checkout is behind origin) | `D`; on **main** | BLOCK | sync first, THEN install: a *bare* install on main clears the block by DOWNGRADING you. `D`'s second cure is spelled `git checkout main && git pull origin main` and that exact spelling is what the allowlist takes — a *bare* `git pull origin main` is not on the list at all. Or pick the downgrade deliberately (check out the commit you want and branch from it) |
| 3 | same message, **X < Y**, on a **feature branch** | `D`; your branch pins its own version | BLOCK | install aligns node_modules to YOUR branch's pin, which is usually what you want. If you actually need the NEWER pin *here*, **there is no cure to run and the deny does not invent one**: it prints the L0 audit-log paths and asks you to contact Dean with them, because that is the evidence the guard logic would have to be designed from (`DRIFT_INVERSE_FIX_SH`). Do NOT reach for `git pull origin main` — it is blocked on a feature branch, and it would merge main into your branch and destroy the fork point |
| 4 | `…-hook not found` / `is declared in package.json but is not installed` | `X`; fresh clone before install, **or a new `git worktree`** — git copies no `node_modules`, so this is the common way to land here with a perfectly healthy repo | BLOCK | run the install **HERE**, in this tree; installing in the primary clone does nothing for this one |
| 4b | `…-hook not found` / `is NOT declared in package.json anywhere`, and `pnpm install` reports **"Lockfile is up to date"** and changes nothing | `U`; the package used to arrive as a TRANSITIVE dependency of another `@webpieces` package (and a hoisting node-linker put its bins in the root `.bin`). That edge was pruned as unused, so the package left the tree entirely | BLOCK | do NOT run `pnpm install` again — with nothing asking for the package it is a **no-op**, and repeating it converges to the same broken tree (2026-08-05: four identical installs, then the block was handed back to the human). The deny infers the pin your other `@webpieces` deps use and prints the exact `add` line |
| 5 | `installed but CRASHED (Cannot find module …)`, often with a count of orphaned pnpm staging dirs | `K`; corrupt / partially-written `node_modules` (an install that was killed) | BLOCK | a *bare* install SKIPS the corrupt package — pnpm sees the right version on disk and considers it installed — so the delete is not optional |
| 6 | a managed hook surface `no longer matches` what the INSTALLED `@webpieces` expects: the shim, the settings.json registration, or its managed `env` entry | `S`; **normal:** an upgrade brought new shim logic, or a new managed surface. **abnormal:** reverted / hand-edited | BLOCK | the preferred cure is the only one that repairs all THREE; the `cp` fallback repairs the shim alone and exists for installed releases older than 0.4.408, where the bin does not exist yet (that gap caused a real "command not found" deadlock, 2026-07-21). Claude Code's own permission prompt may ask you to confirm the `cp` — that prompt is NOT this guard. Do NOT reach for the installer: it also migrates your config and prompts twice, which hangs a non-interactive agent |
| 7 | **any** complaint about `webpieces.config.json`: `not found` (`C`), `is out of sync` (`Y`), an N-error validation banner, or a parse error | `C`/`Y`/validation/syntax — one class, not four | BLOCK | see "The config-validation invariant" above; that section is the authority. Do NOT run `pnpm install` (it cannot help), and DO delete any key reported as unknown |
| 8 | nothing — no fault | — | → L1 | logged as `layer=L0 row=1`, so "the guard ran and found nothing" is distinguishable from "the guard never ran" |
| 9 | your cure is allowed through while everything else is denied | any fault, call on the allowlist | PASS or ALLOW | this is row 2 of the matrix, and it is what keeps recovery reachable — run the cure yourself rather than handing the block back |
| 10 | Reads succeed while `D`/`X`/`U`/`K` blocks Bash | the bin never ran, so PASS degenerates to a **terminal allow** | ALLOW_FAIL_OPEN | nothing to do — but note reads are UNGUARDED during those four (see "Two known gaps") |
| 11 | you are blocked in one tree and `pnpm install` keeps succeeding without clearing it | any fault, measured against `$ROOT` — the tree the ABSOLUTE hook resolves to, i.e. the one `$CLAUDE_PROJECT_DIR` names — while you stand somewhere else | BLOCK, then ALLOW once you look | `pwd` is on the allowlist for exactly this; compare it with the `root=`/`shim=` path the deny names and cure THAT tree. Do NOT re-run the same bare install a second time — it already succeeded, in the wrong tree (2026-08-03: five identical installs, then the block was handed back to the human) |

Row 7 is the collapse: `C`, `Y`, a validation banner and a syntax error look like four problems and
are one. They all mean the file is wrong, and they all cure to making it right.

**Consumers trip `S` on every upgrade that changes the managed surface, and must run the cure before
continuing. That is the designed inline-upgrade forcing function working, not a regression.**

## Two known gaps

- **`D` is blind to range specs.** Only EXACT pins are compared; `^`, `~`, `workspace:*` are skipped
  ("they never drift"). A consumer pinning with `^` gets no drift protection. `catalog:` was the same
  blindness and caused the 2026-07 `0.3.369 vs 0.4.405` incident — fixed by resolving through
  `pnpm-lock.yaml`. Ranges remain.
- **The `D`/`X`/`U`/`K` Read asymmetry** (use case 10). Narrowing the Read entry to a path pattern is the
  fix; deliberately deferred. The read-only orientation entry sits in the same asymmetry: the bin never
  runs under those four, so an allowed `git status` is terminal rather than falling through to L1. It
  reads and reports only, so the exposure is disclosure, not mutation — but it is the same gap, and the
  same narrowing closes both.

## The OTHER generated L0 doc — `webpieces.guard-matrix.md`

The block at the top of this file is not the only rendering of `L0_FAULTS`. `renderGuardMatrixDoc()`
(`core/l0-matrix.ts`) renders the fault table, the per-fault **Fix sections** and the allowlist into
`packages/tooling/rules-config/templates/webpieces.guard-matrix.md`, which a unit test locks
byte-identical. The difference is WHERE each is read:

| doc | shipped how | read when |
|---|---|---|
| `webpieces.guard-matrix.md` | a rules-config TEMPLATE, dropped into `<root>/.webpieces/instruct-ai/` | LAZILY, on an L0 BLOCK — the deny appends `READ <path>` |
| this file | tracked in the repo | by anyone reasoning about the layer, blocked or not |

`writeGuardMatrixDoc(workspaceRoot)` does that drop, atomically and only when the bytes changed, from
two call sites: `hook-core.ts` (fault `S`) and `runner.ts` (fault `C`). Best-effort — a missing template
degrades the deny to no pointer, never to a crash.

Both render from `L0_FAULTS[].cures`, where each `L0Cure` carries the exact call, a `preferred` flag
(exactly one per fault) and a `discriminator` — the sentence saying WHEN to pick a sibling instead. Two
assertions in `l0-matrix.spec.ts` keep that honest: every cure must be accepted by `isAllowed()` AND
named in its fault's deny text, and — scraping the RENDERED output, not the array — **every command
printed in any Fix section must pass `isAllowed()`**. `l0-tooling-doc.spec.ts` asserts the same property
over the block in THIS file. That second kind of assertion is what would have caught a FLAGGED
`pnpm wp-install-ai-hooks` being prescribed by config messages while the installer allowlist entry
accepted no flags at all.

---

## Worked example — the two faults fire in sequence on an upgrade

Observed live. `main` bumps the `@webpieces` pin to a newly published release:

1. Next tool call → **`D`**: "pins `0.4.545` but node_modules has `0.4.526`". Cure: the install.
2. Next tool call → **`S`**: the committed shim was rendered by `0.4.526` and no longer matches
   `0.4.545`'s `renderShim()`. Cure: the upgrade command.
3. Guards re-armed.

Two blocks, two one-line cures, no deadlock.

Step 2's cure is bigger than its name suggests, and that is deliberate — the bin is called
`wp-upgrade-shim` for historical reasons and is deliberately NOT renamed. Fault `S` covers the WHOLE
managed hook surface, the three things listed in the generated block above, and they only work as a set.

It was FOUR. A third hook, `.claude/webpieces/guarantee-root.sh` (L-1), is **deleted**, and so is the
RELATIVE registration it existed to protect. Both guard hooks are ABSOLUTE now (the generated block
prints the two exact commands), so they resolve from any cwd, the launch guarantee is structural rather
than policed, and `cd` into a subdirectory is no longer denied. The relative form had been adopted so
each tree would run its own release; measured 2026-08-10, it never did — a linked worktree has no
`node_modules`, so the shim's upward walk always ran the MAIN tree's binary. The MAIN tree governs every
tree, and when a worktree PINS a different `@webpieces`, L1 row 8 (`trinary-version-skew`) blocks and
names the fix. `LEGACY_GUARANTEE_ROOT_MARKER` survives in `hook-registration.ts` as a one-way
RECOGNISER — nothing emits it; it exists so `repairRegistration()` can find and DELETE a retired entry.

The third managed surface (`env.CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR=1`) is no longer load-bearing
for hook RESOLUTION — an absolute hook always resolves. It is kept for VERDICT STABILITY: pinning the
Bash cwd to the project root means a guard's answer depends on the command, not on where an earlier `cd`
left the shell, and because settings `env` is **inherited**, the main agent and every subagent get the
same cwd and therefore the same verdict. The trade: the cwd reset becomes silent and unconditional, so a
deliberate `cd` no longer persists between Bash calls — chain instead.

Nothing validated the registration at all before it joined this fault, so a settings file left on a
superseded form silently changed who governs, with no signal anywhere. A repair fixes the tree it is RUN
IN, and because the hooks are absolute the tree that governs the session is the one `$CLAUDE_PROJECT_DIR`
names — so cure the tree the deny's `root=` names. `wp-upgrade-shim` says so when the two trees diverge
and prints the primary-tree command; `governingShimRoot()` compares the tree the running binary came from.

## The audit log — checking observed behaviour against this document

Everything above says what L0 is SUPPOSED to do. The shim writes **one line per tool call** — every
call, not only the broken ones — so what it actually did can be diffed against these tables instead of
inferred. The line's shape, its fields and the verdict vocabulary are in the generated block above,
rendered from `SHIM_LOG_FIELDS` and `SHIM_LOG_VERDICTS`; what follows is why each of them is there.

`layer=` and `row=` are the **join keys**, and they are why that diff is a lookup rather than an
investigation: every L0 deny opens `[<guard>] (layer=L0 fault=<code> row=3, …)` with the identical
triple, and `webpieces.guard-matrix.md` prints the same row. One grep of `fault=S` or of
`layer=L0 row=3` lands you in all three artifacts.

`shim=` is on every line: compared against `tree=` it is the STRADDLE detector (`tree=agent-X
shim=<repo>` = standing in one tree, judged by another), and that pair varies constantly.

`bin=` is **optional, and its presence IS the diagnostic** — it appears only when the binary came from a
different tree than the shim. Measured across 549 real lines it differed on 39, every one a worktree
agent's first calls before it ran `pnpm install`; and since the hooks went ABSOLUTE, `shim=` is always
the main tree, so the two can now only differ when the MAIN tree has no `node_modules`.

`fault=` on an `L0-shim` line can only carry the `sh`-side letters: `S`/`C`/`Y` are decided inside the
binary — which, on a `fault=-` line, is exactly what ran. So `fault=-` here is a statement about the
**`sh` layer only**, never a claim that nothing was wrong. The letters come from
`core/l0-fault-codes.ts`, which is also where the shim's `WP_FAULT=` values and `SHIM_LOG_FAULTS` come
from — one codebook, no retyping — and `audit-fault-stamp.spec.ts` drives the partition from `L0_FAULTS`
itself, so an eighth fault with no emitter fails the build.

Fault `S` used to leave **nothing, anywhere**. `enforceCommittedShim` runs before
`invocationLog.begin()`, so the terminal boundary had no pending line to flush, and an `S` storm that
blocked roughly twenty consecutive tool calls was invisible except as a couple of rejection lines
attributed to whatever downstream rule the report happened to cite. It now writes its own `BLOCK`
decision line, stamped `fault=S` and `layer=L0 row=3`.

`PASS-BIN-*` is the line that used to be missing. `wp_log` fired only on the fail-closed path, so a
healthy call recorded nothing and an absent line meant either "fine" or "the shim never ran" — the two
answers a reader most needs to tell apart.

`tree=` is git's own name for the worktree the CALL was made in (`primary` in the primary clone),
derived from the payload's `cwd`, and it decides which tree's directory the line lands in (the paths are
in the generated block). It is deliberately NOT the same question as `shim=`: the hooks are registered
ABSOLUTE, so the copy that runs is the SESSION ROOT's whatever tree you are standing in, and the two
CAN differ. The log prints both precisely so that straddle is visible rather than inferred — an earlier
version of this paragraph claimed a RELATIVE registration made them identical by construction, which was
wrong in both halves.

Two properties this log must never trade away, both locked by `shim-audit-log.spec.ts`: it never
writes to stdout (stdout is the PreToolUse decision channel — one stray byte corrupts allow/deny), and
it never blocks or fails a hook (an unwritable log directory leaves the outcome bit-for-bit unchanged).

## Code anchors

| section | file | symbol |
|---|---|---|
| faults, cures, the matrix doc | `ai-hook-rules/src/core/l0-matrix.ts` | `L0_FAULTS`, `renderGuardMatrixDoc`, `writeGuardMatrixDoc` |
| the generated block of THIS file | `ai-hook-rules/src/core/l0-tooling-doc.ts` | `L0ToolingDoc.render/extract/splice`, `L0_DOC_BEGIN` |
| the allowlist | `ai-hook-rules/src/bin/l0-allowlist.ts` | `L0_ALLOWLIST`, `isAllowed`, `L0_CURE_ALLOW_JS` |
| `S` enforcement | `ai-hook-rules/src/adapters/hook-core.ts` | `enforceCommittedShim`, `shimStaleRecoveryDecision` |
| the three managed surfaces | `ai-hook-rules/src/bin/hook-registration.ts` | `managedSurfaceDrift`, `shimCommand`, `SHIM_SURFACE`, `REGISTRATION_SURFACE`, `ENV_SURFACE` |
| fault `S`'s deny text | `ai-hook-rules/src/bin/shim-deny-reason.ts` | `shimStaleDenyReason` |
| `D`/`X`/`U`/`K` enforcement | `ai-hook-rules/templates/ai-hook.sh` | the pre-binary `sh` block |
| the audit log | `ai-hook-rules/src/bin/shim-audit-log.ts` | `SHIM_LOG_FIELDS`, `SHIM_LOG_PRINTF`, `SHIM_LOG_VERDICTS`, `WP_LOG_SH`, `RESOLVE_LOG_DIR_SH` |
| the fault codebook and join keys | `ai-hook-rules/src/core/l0-fault-codes.ts` | `L0_FAULT_NAMES`, `L0_LAYER`, `L0_ROW_*`, `l0GuardHeader` |
| the JS-side `fault=` stamp | `ai-hook-rules/src/core/decision-log.ts` | `GuardDecision.fault`, `MATRIX_L0_BLOCK`, `InvocationLog.finish` |
| where any log goes | `rules-config/src/state-dir.ts` | `LOGS_STATE_DIR`, `DotWebpieces.logs()` |
