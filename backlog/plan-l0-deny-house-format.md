# Plan — bring the L0 denies into the house format, and gate fault S's cure on the caller

## Why

Every L1/L2 guard deny is rendered by `formatReport()` (`core/report.ts`): a header naming what was
blocked, a `[rule-name] (N violations)` block, indented offenders each with a one-line `→ why`, then
`Fix Option N:` lines. It is scannable — a reader finds the command without reading the prose.

The seven L0 faults are the only denies in webpieces that do not do this. They render as ONE
paragraph. Fault S is the worst: ~3,300 characters (its own budget test pins the ceiling at 3350),
eleven sentences deep, with the two commands that matter buried mid-paragraph and no guard name
anywhere. It also prescribes exactly one cure regardless of who is blocked, which is wrong for a
worktree-isolated subagent.

Length is NOT the target. Structure is. A message that is 3,300 characters across labelled sections
is scannable; the same 3,300 characters as one paragraph is not.

## Scope

Both halves of L0, because "L0 does not follow the house format" is true of both:

| fault | decided in | text built in |
|---|---|---|
| `S` managed-hook-surface drift | the guard BINARY, JS | `bin/shim-deny-reason.ts` → `shimStaleDenyReason()` |
| `D` version drift | POSIX sh, pre-binary | `DENY_REASON_SH` in `bin/shim.ts` |
| `X` bin missing | POSIX sh, pre-binary | `DENY_REASON_SH` |
| `U` package undeclared | POSIX sh, pre-binary | `DENY_REASON_SH` |
| `K` bin present but crashed | POSIX sh, pre-binary | `DENY_REASON_SH` |

`C` (config missing) and `Y` (config out of sync) are OUT of scope: `CONFIG_MISSING_REPORT` is already
line-broken and lives in `core/l0-matrix.ts`, and `Y`'s text is assembled by the runner per-rule.
Naming them here so a reader knows the omission is deliberate.

## The skeleton every L0 deny adopts

Copied from `formatReport()`, not invented:

```
❌ webpieces ai-hooks blocked this call: <one line — what happened>

[<guard-name>] (fault <CODE>)
  <the offending thing>
    → <one sentence: why>

Where this was measured:            (fault S only — it is the one fault with two trees in play)
  root=<...>
  projectDir=<...>
    → <the AGREE/DISAGREE verdict>

Still allowed while this block is up:
  - <short list>
  THIS IS NOT A DEADLOCK - run a Fix Option yourself now; do not hand it back to the human.

  Fix Option 1: (preferred) <when to pick it>
    run EXACTLY: '<command>'
  Fix Option 2: <when to pick it>
    run EXACTLY: '<command>'

<NO_CHAINING_RULE>
```

Deliberately kept from today's text, because deleting any of them re-opens a recorded incident:

- `NO_CHAINING_RULE` verbatim (the `&& git status` deadlock).
- The NOT-A-DEADLOCK sentence (an agent handed a live block back to a human).
- `root=` / `projectDir=` with the AGREE/DISAGREE verdict (four cures aimed at the wrong tree).
- Every runnable command byte-for-byte, including its `cd <root> &&` prefix. The L0 allowlist matches
  WHOLE command strings, so a reworded cure is an unrunnable cure. Never a second `cd … &&`.

## Newlines — the delicate part

The reason string reaches the human through a JSON string in both halves, and they get there
differently:

- **JS half (fault S).** `denyJson()` (`adapters/claude-code-response.ts`) runs `JSON.stringify`,
  which escapes a real `\n` into `\\n` on the wire. This needs NO new mechanism and is already proven
  in production: every L1 deny is `formatReport()`'s multi-line string down this exact path.
  So `shimStaleDenyReason()` may simply contain real newlines.
- **sh half (faults D/X/U/K).** `REASON` is a shell variable `printf`'d into a JSON string literal.
  A REAL newline there is invalid JSON. The shim already solves the identical problem for the ANSI
  escape: `BS='\'` then `ESC="${BS}u001b"` — six characters, which Claude Code's JSON parser turns
  into a real ESC. Newlines take the same route: `NL="${BS}n"` (two characters, backslash + n),
  interpolated into `REASON`. `printf '%s'` does not interpret escapes in its ARGUMENTS, so the two
  characters land in the JSON string verbatim and the parser turns them into newlines.

  `BS`/`ESC` currently live INSIDE `DENY_EMIT_SH`'s Bash branch, i.e. after `REASON` is built. They
  move to a new `ESCAPES_SH` fragment spliced in ahead of `DENY_REASON_SH`; `DENY_EMIT_SH` then uses
  the hoisted `ESC` instead of redefining it. Nothing else about the emit changes.

**The constraint that does NOT relax:** the reason string may contain no `"` and no `\`. In the sh
half that is because `REASON="…"` is a shell assignment; in the JS half it is asserted by unit test.
`${NL}` satisfies both — it is a variable reference in the source, and the backslash it expands to is
produced by the shell at runtime, never written into the assignment. Every interpolated path stays
stripped of `"` and `\`.

### How this is proved, not assumed

New tests (they are the deliverable, not a formality):

1. **`renderShim()` through a real `/bin/sh`, per sh-side fault**: `JSON.parse(stdout)` succeeds and
   `permissionDecisionReason` contains a REAL `\n`. That single assertion proves the escape survives
   printf, the JSON, and the parser.
2. **The red survives**: on a Bash payload the emitted JSON parses AND `systemMessage` contains
   `[31;1m` and `[0m`. Asserted for the sh half (through `/bin/sh`) and the JS half (through
   `denyJson`). Multi-line must not cost the red — that is the one regression this change could
   plausibly ship.
3. **`permissionDecisionReason` stays ESC-free** (existing invariant: only `systemMessage` is ANSI).
4. The existing "no `"` / no `\`" assertions in `shim-deny-reason.spec.ts` and
   `shim-governing-root.spec.ts` stay exactly as they are and must stay green.

## The caller-gated cure branch (fault S)

Today fault S prescribes `cd <root> && pnpm exec wp-upgrade-shim` and then, for a subagent, tells it
to escalate `pnpm install` in the main tree so both trees are on the same `@webpieces` version. That
last clause GOES: both hooks are registered ABSOLUTE, so every tree is judged by MAIN's shim and
MAIN's binary already — there is nothing to align, and saying otherwise sends an agent after a
non-problem.

Two observable inputs, both already computed:

1. `inSubagent` — `agent_id` is present in the PreToolUse payload ONLY inside a subagent (`agent_type`
   is always populated and discriminates nothing). Used for MESSAGE SHAPE only. It must NEVER decide
   which tree a call acts on; that is decided from the path, and a deleted `AgentIdentity` class was
   removed for exactly that overreach.
2. `root === projectDir` — `governingShimRoot()` vs `CLAUDE_PROJECT_DIR`. Different ⇒ the caller is
   not standing in the tree that needs repair.

| caller | branch |
|---|---|
| main agent (`inSubagent` false) | cure as today. No escalation clause. |
| subagent whose cwd IS the tree (`root === projectDir`) | same — it can run, verify and commit. |
| worktree-isolated subagent (`inSubagent` AND `root !== projectDir`) | run the cure, THEN escalate. |

The escalation wording is bounded by what was MEASURED on 2026-08-11: a worktree-isolated subagent
CAN run `cd <main> && pnpm exec wp-upgrade-shim` and it works — the harness refuses cross-tree GIT
operations, not this. What it cannot do is verify or commit the result, because `git -C <main>` is
refused. So the text says: run Fix Option 1 as printed (it is real, never conclude a local cure
cannot work), then tell the coordinator to run `git status` in the main clone and commit the
regenerated shim. That is an escalation of the COMMIT, not of the repair.

Implementation note: the branch is a pure function of `(inSubagent, safeRoot === projectDir)`, so it
is testable without a harness, and it changes only the message — never the block/allow decision, never
which command is printed.

## Files touched

- `packages/tooling/ai-hook-rules/src/bin/shim-deny-reason.ts` — fault S, rewritten to the skeleton
  with the caller branch. The rendering moves onto a class (per CLAUDE.md "new logic is instance
  methods"); `shimStaleDenyReason()` stays as the one exported entry point its two call sites use.
- `packages/tooling/ai-hook-rules/src/bin/shim.ts` — `ESCAPES_SH` hoist, `DENY_REASON_SH` rewritten to
  the skeleton with `${NL}`, `DENY_EMIT_SH` uses the hoisted `ESC`.
- `packages/tooling/ai-hook-rules/templates/ai-hook.sh` — regenerated (byte-locked to `renderShim()`).
  `.claude/webpieces/ai-hook.sh` is deliberately NOT regenerated: it is the artifact, and in this repo
  the local source runs ahead of the pinned `node_modules`.
- The specs that assert exact phrases — updated to the NEW phrases, never weakened, never deleted:
  `shim-deny-reason.spec.ts`, `shim-governing-root.spec.ts`, `shim-drift.spec.ts`,
  `l0-fault-u.spec.ts`, `setup.spec.ts`.

## No backwards-compat

The old paragraph form is DELETED, not kept behind a flag. There is one spelling of an L0 deny.

## Added after the plan was written (all verified, all in this PR)

### The THREE-WAY JOIN — the deny, the audit line and the matrix row share coordinates

One L0 event produces three artifacts and they shared NO common coordinate: the deny named no guard, no
fault letter and no row, so a transcript could not be debugged against the log after the fact.

- `core/l0-fault-codes.ts` (a LEAF module, no imports — which is why all three halves can reach it)
  gains `L0_FAULT_NAMES` (a stable kebab guard name per fault, the shape L1 already uses:
  `[stale-main-bash-guard]`), `L0_ROW_HANDED_DOWN|ALLOWLISTED|BLOCKED`, and the two builders
  `l0GuardHeader()` / `l0MatrixCitation()`.
- Every L0 deny — all seven faults, `sh` half included (the shim interpolates the builders at RENDER
  time, so it needs no runtime import) — now opens
  `[<guard>] (layer=L0 fault=<code> row=3, N violations)` and cites the row and the dimension values.
- The matrix doc gains a `guard` column and renders its row numbers from the same constants.
- `MATRIX_L0` is SPLIT into `MATRIX_L0_ALLOW` / `MATRIX_L0_BLOCK` (row 2 / row 3). It carried `row: '-'`
  before, which is what made the row unciteable.
- The **sh** audit line gains `layer=L0` and `row=<1|2|3>`. Without this the deny's claim that the log
  carries the same coordinates was TRUE for the JS half and FALSE for the other four faults, and
  `grep 'layer=L0 row=3'` would have found one fault out of five. `row=` varies with the verdict
  (hand-down / allowlisted / blocked), so it is not constant padding.
- `l0-matrix.spec.ts` asserts the join across all three artifacts, for every fault.

### RED ON THE HEADLINE ONLY

A multi-line body entirely in bold red is worse than the paragraph it replaced — the indentation that
carries the structure stops registering. Both emitters now close the ANSI sequence before the first
newline: `redSystemMessage()` (JS) and `DENY_EMIT_SH` (sh, via a per-branch `$WP_HEAD` plus POSIX
prefix removal `${REASON#"$WP_HEAD"}`). Asserted on both paths: line 0 opens `ESC[31` and ends `ESC[0m`,
every later line is ESC-free, and the payload still parses.

### Two small items folded in

- **`bin=` is printed only when it differs from `shim=`** (sh audit line). Measured: it differed on 39 of
  549 real lines, all a worktree agent's first calls before `pnpm install`, and since the hooks went
  ABSOLUTE it can only differ when the MAIN tree has no node_modules. Its PRESENCE is now the diagnostic.
  `shim=` stays on every line — against `tree=` it is the straddle detector. An if-and-only-if test pins it.
- **`VersionSyncGuard`'s row-8 report joins the banned-phrase sweep.** It was the last surface not
  covered, and the one most likely to regrow the phrase. `version-sync.spec.ts` exports
  `renderVersionSyncRow8Report()` so the existing tmp-dir fixtures are reused rather than duplicated.

## Verify

1. `pnpm exec vitest run packages/tooling/ai-hook-rules/`
2. `pnpm nx run ai-hook-rules:lint`
3. `pnpm nx affected --target=ci --base=<merge-base sha>`
4. Commit → `wp-start-upsert-pr` → `wp-review-upsert-pr` → review.json → reviewer → `wp-finish-upsert-pr`.
