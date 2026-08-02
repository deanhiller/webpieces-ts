# webpieces guard matrix — L0 (tooling integrity)

GENERATED from `L0_FAULTS` + `L0_ALLOWLIST` in `@webpieces/ai-hook-rules`. Do not hand-edit —
a unit test locks this file byte-identical to `renderGuardMatrixDoc()`, so the table below is
the array the guard actually consults, not a description of it.

L0 is the OUTERMOST guard layer. It blocks work while `node_modules`, the committed shim, or
`webpieces.config.json` are in a state that makes every other guard untrustworthy. If you are
reading this, one of the six faults below fired and named this file.

## The faults

| code | fault | detected by | enforced in |
|---|---|---|---|
| `D` | version drift — root package.json pin != installed version | sh, before the bin runs | sh |
| `X` | guard bin missing (fresh clone / new worktree / package removed) | sh, before the bin runs | sh |
| `K` | guard bin present but CRASHED (exit code not 0 or 2 — corrupt node_modules) | sh, before the bin runs | sh |
| `S` | committed .claude/webpieces/ai-hook.sh != renderShim() | the guard bin | JS |
| `C` | webpieces.config.json missing | the guard bin | JS |
| `Y` | a loaded rule has no webpieces.config.json key | the guard bin | JS |

First match wins. `D`/`X`/`K` are decided in POSIX `sh` inside the committed shim, BEFORE the
guard bin runs — a stale, missing or broken validator cannot be trusted to validate itself.

## The matrix

L0 has NO genuine second dimension. Every branch reduces to one question:

| # | fault | on the allowlist? | outcome |
|---|---|---|---|
| 1 | none | — | hand down to the next guard layer |
| 2 | any | yes | PASS or ALLOW (see the entry) |
| 3 | any | no | BLOCK — **only the message varies by fault** |

The tool is not a dimension either: "any Read" is an allowlist ENTRY, not a tool check.

## The allowlist

ONE list, consulted identically by all six faults. A cure that cannot help a given fault also
cannot hurt it, and gating each entry on a fault is what produced four real defects (a stale
shim that denied `pnpm install` and `git pull`; faults that denied every Read; a config fault
that denied `rm -rf node_modules && pnpm install` while allowing a bare `pnpm install`).

| # | allowed | outcome |
|---|---|---|
| 1 | any Read | PASS |
| 2 | a Write/Edit whose target is webpieces.config.json | PASS |
| 3 | pnpm|npm install | ALLOW |
| 4 | rm -rf node_modules && pnpm install - the cure for a CORRUPT node_modules | ALLOW |
| 5 | git pull / git fetch - merge is NOT on the list | ALLOW |
| 6 | pnpm exec wp-upgrade-shim | ALLOW |
| 7 | cp node_modules/@webpieces/ai-hook-rules/templates/ai-hook.sh .claude/webpieces/ai-hook.sh | ALLOW |
| 8 | pnpm exec wp-install-ai-hooks | ALLOW |

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
guards. Under `D`/`X`/`K` the bin is never executed, so there is nothing to fall through to and a
PASS degenerates into a terminal allow — reads are unguarded during those three faults.

## Widening L0

Add an entry to `L0_ALLOWLIST` in `packages/tooling/ai-hook-rules/src/bin/shim.ts`. That array is
the single source for the JS allowlist, the `grep -E` inside the rendered shim, and this file.
