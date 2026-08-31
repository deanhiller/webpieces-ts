# webpieces guard matrix — L0 (tooling integrity)

GENERATED from `L0_FAULTS` + `L0_ALLOWLIST` in `@webpieces/ai-hook-rules`. Do not hand-edit —
a unit test locks this file byte-identical to `renderGuardMatrixDoc()`, so the table below is
the array the guard actually consults, not a description of it.

L0 is the OUTERMOST guard layer. It blocks work while `node_modules`, the committed shim, or
`webpieces.config.json` are in a state that makes every other guard untrustworthy. If you are
reading this, one of the faults below fired and named this file.

## The faults

THE JOIN KEYS ARE `guard`, `fault=` and `row=`. Every L0 deny opens
`[<guard>] (layer=L0 fault=<code> row=3, …)`, and every audit line — from BOTH halves of L0, the
`sh` shim and the guard bin — carries `layer=L0 row=<n> fault=<code>`. So one grep lands you in
the deny, the log line and the row below. The guard names come from `L0_FAULT_NAMES` and the row
numbers from `L0_ROW_*`, both spelled in exactly one place (`core/l0-fault-codes.ts`).

| code | guard | fault | detected by | enforced in |
|---|---|---|---|---|
| `D` | `version-drift` | version drift — root package.json pin != installed version | sh, before the bin runs | sh |
| `X` | `guard-bin-missing` | guard bin missing (fresh clone / new worktree / package removed) | sh, before the bin runs | sh |
| `U` | `guard-pkg-undeclared` | guard bin missing AND @webpieces/ai-hook-rules is not declared in package.json | sh, before the bin runs | sh |
| `K` | `guard-bin-crashed` | guard bin present but CRASHED (exit code not 0 or 2 — corrupt node_modules) | sh, before the bin runs | sh |
| `S` | `managed-hook-surface` | a webpieces-managed hook file, one of the harness hook registrations (.claude/settings.json, .codex/hooks.json) or the managed env entry does not match this release | the guard bin | JS |
| `C` | `config-missing` | webpieces.config.json missing | the guard bin | JS |
| `Y` | `config-out-of-sync` | a loaded rule has no webpieces.config.json key | the guard bin | JS |

First match wins. `D`/`X`/`U`/`K` are decided in POSIX `sh` inside the committed shim, BEFORE the
guard bin runs — a stale, missing or broken validator cannot be trusted to validate itself.

## The fix, per fault

Every command below is rendered from that fault's `cures` array and is asserted, by unit test,
to be accepted by `isAllowed()` — so nothing here can be a command the guard then rejects. Type
the option you pick EXACTLY as written and run nothing else on that line.

### `D` — version drift — root package.json pin != installed version

- **Option 1 (preferred)**: `pnpm install`  ← pick this when node_modules is OLDER than the pin, OR you are on a feature branch and want YOUR branch pin (usually the case) — it always clears the drift
- **Option 2**: `git checkout main && git pull origin main`  ← pick this when node_modules is NEWER than the pin AND you are on main — the PIN is the stale side, so sync first and install second; a bare install would downgrade you

### `X` — guard bin missing (fresh clone / new worktree / package removed)

- **Option 1 (preferred)**: `pnpm install`  ← pick this when this fault fires at all — nothing is installed in THIS tree, and a new git worktree copies no node_modules

### `U` — guard bin missing AND @webpieces/ai-hook-rules is not declared in package.json

- **Option 1 (preferred)**: `pnpm add -D @webpieces/ai-hook-rules`  ← pick this when this fault fires at all — package.json asks for nothing, so pnpm install reports "Lockfile is up to date" and leaves the tree exactly as broken as it found it

### `K` — guard bin present but CRASHED (exit code not 0 or 2 — corrupt node_modules)

- **Option 1 (preferred)**: `rm -rf node_modules && pnpm install`  ← pick this when this fault fires at all — a BARE pnpm install SKIPS the corrupt package, because pnpm sees the right version on disk and considers it installed; only the delete forces a rewrite

### `S` — a webpieces-managed hook file, one of the harness hook registrations (.claude/settings.json, .codex/hooks.json) or the managed env entry does not match this release

- **Option 1 (preferred)**: `pnpm exec wp-upgrade-shim`  ← pick this when this fault fires at all — it is the only cure that repairs EVERY managed surface (ai-hook.sh, each harness hook registration, and the Claude settings env entry), and it also deletes the retired guarantee-root.sh and any entry still naming it, and it touches no config; needs installed @webpieces/ai-hook-rules 0.4.408 or newer
- **Option 2**: `cp node_modules/@webpieces/ai-hook-rules/templates/ai-hook.sh .claude/webpieces/ai-hook.sh`  ← pick this when the installed @webpieces/ai-hook-rules is OLDER than 0.4.408, so wp-upgrade-shim does not exist yet — it is PARTIAL (it repairs ai-hook.sh and NOTHING else), so upgrade @webpieces afterwards and run Option 1 to finish

### `C` — webpieces.config.json missing

- **Option 1 (preferred)**: edit `webpieces.config.json` yourself  ← pick this when this fault fires at all — it is the only cure that needs no other tool, and it is never denied
- **Option 2**: `pnpm exec wp-install-ai-hooks`  ← pick this when you are at an INTERACTIVE terminal and can answer its two hook-target prompts

### `Y` — a loaded rule has no webpieces.config.json key

- **Option 1 (preferred)**: edit `webpieces.config.json` yourself  ← pick this when this fault fires at all — it is the only cure that needs no other tool, and it is never denied

## The matrix

L0 has NO genuine second dimension. Every branch reduces to one question:

| # | fault | on the allowlist? | outcome |
|---|---|---|---|
| 1 | none | — | hand down to the next guard layer |
| 2 | any | yes | PASS or ALLOW (see the entry) |
| 3 | any | no | BLOCK — **only the message varies by fault** |

Row 3 is the only row that blocks, so every L0 deny cites it — `row=3` in the
deny header, `row=3` on the audit line, and this row here. Same numbers as L1 uses for
its own rows (see `L1_ROWS`), and for the same reason: a row number is IDENTITY, so it is never reused.

The tool is not a dimension either: "any Read" is an allowlist ENTRY, not a tool check.

## The allowlist

ONE list, consulted identically by every fault. A cure that cannot help a given fault also
cannot hurt it, and gating each entry on a fault is what produced four real defects (a stale
shim that denied `pnpm install` and every git sync; faults that denied every Read; a config fault
that denied `rm -rf node_modules && pnpm install` while allowing a bare `pnpm install`).

| # | allowed | outcome |
|---|---|---|
| 1 | any Read | PASS |
| 2 | a Codex tool with nothing to judge: webrun, collaborationspawn_agent, collaborationwait_agent, view_image, update_plan | PASS |
| 3 | a Write/Edit whose target is webpieces.config.json | PASS |
| 4 | a Write/Edit whose target is a tree ROOT's pnpm-workspace.yaml or package.json - the version pin | PASS |
| 5 | pnpm|npm install | ALLOW |
| 6 | rm -rf node_modules && pnpm install - the cure for a CORRUPT node_modules | ALLOW |
| 7 | git fetch - a bare git pull and git merge are NOT on the list | ALLOW |
| 8 | git checkout main && git pull origin main | ALLOW |
| 9 | pnpm exec wp-upgrade-shim | ALLOW |
| 10 | cp node_modules/@webpieces/ai-hook-rules/templates/ai-hook.sh .claude/webpieces/ai-hook.sh | ALLOW |
| 11 | pnpm wp-prune-unknown-config | ALLOW |
| 12 | pnpm exec wp-install-ai-hooks (flags allowed, e.g. --target=project) | ALLOW |
| 13 | pnpm add -D @webpieces/ai-hook-rules (an @version and extra flags allowed) | ALLOW |
| 14 | read-only orientation: pwd, git status/log/diff/show/branch/rev-parse, git worktree list | ALLOW |

- **PASS** — L0 has no objection; the call falls THROUGH so the downstream guards still judge it.
- **ALLOW** — terminal; bypasses everything, because a cure must stay reachable even when a
  downstream guard would block it.

Every Bash entry is anchored to the WHOLE command. A leading `cd <dir> &&`, a trailing `2>&1`
and a pipe into `tail`/`head` are tolerated; nothing else is. Appending `&& git status` makes it
a DIFFERENT command and it is rejected again — that is not the guard refusing its own cure.

`git merge` is deliberately NOT on this list. Main is merged ONLY through the 3-point fork merge
(`pnpm wp-start-update`, or `pnpm wp-start-upsert-pr` when a PR is already open).

## Known asymmetry

Under `S`/`C`/`Y` the guard bin IS running, so a PASS really does fall through to the downstream
guards. Under `D`/`X`/`U`/`K` the bin is never executed, so there is nothing to fall through to and a
PASS degenerates into a terminal allow — reads are unguarded during those three faults.

## Widening L0

Add an entry to `L0_ALLOWLIST` in `packages/tooling/ai-hook-rules/src/bin/shim.ts`. That array is
the single source for the JS allowlist, the `grep -E` inside the rendered shim, and this file.
