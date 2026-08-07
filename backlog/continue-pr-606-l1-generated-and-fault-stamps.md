# Continue PR #606 — L1 generated + L0 fault stamps

**Say "let us continue the work on 606" and read this file first. It is the whole handoff.**

PR: https://github.com/deanhiller/webpieces-ts/pull/606
Branch: `deanhiller/l1-generated-plus-fault-stamps` — worked in the **primary clone**, not a worktree
(see "How to work on this" below).

---

## 1. State right now

| | |
|---|---|
| PR #606 | **OPEN, approved, auto-merge ARMED, not a draft** |
| Reviewer | `backwards-compat-reviewer` → **yellow** (passes with concerns), no shim found |
| Build | `build-all` green · 749 ai-hook-rules tests · 504 rules-config tests |
| Superseded | #579 is CLOSED — its branch was abandoned mid-merge and archived as `archive/2026-08-07/worktree-agent-a64e44d506caccbcf-{l1,audit}` |

**To land it:** `pnpm wp-start-upsert-pr` → `pnpm wp-review-upsert-pr` → spawn `backwards-compat-reviewer`
(as its OWN subagent type, not `general-purpose`) → `pnpm wp-finish-upsert-pr` → `pnpm wp-land-pr`.

---

## 2. What the PR does

### L1 is now generated and byte-locked

`L1_ROWS` (`ai-hook-rules/src/core/l1-rows.ts`) is an ordered array of six rows carrying K/A/R/G/P,
action, cure, `blockId` and fifteen `useCases[]`. `renderL1Doc()` (`core/l1-doc.ts`) renders
`guards/L1-location.md` from it; `l1-matrix.spec.ts` locks them byte-for-byte (24 tests: byte-lock,
totality over all 64 classifications, witness/no-shadow, cure reachability, predicate parity).
`l1LocationBlock` (`core/runner.ts`) classifies, takes the first matching row and dispatches on
`blockId` — **delete a row and its block stops firing.** `pnpm guards:generate` rewrites the doc.

**The correctness proof: `guards/L1-location.md` does not appear in the PR diff at all.** The generator
reproduces main's current file exactly, so the extraction provably lost nothing. Preserve that property
— any change that alters the rendered file forfeits it.

### Every L0 fault now carries a `fault=` stamp

Only `D`/`X`/`U`/`K` did (assigned in the POSIX `sh` shim). `S`/`C`/`Y` are enforced in the bin and
reached the audit trail unlabelled — and fault `S` left **nothing at all**, because
`enforceCommittedShim` runs before `invocationLog.begin()`, so the terminal flush found a null `pending`
and returned silently. An `S` storm that blocked ~20 consecutive tool calls this session was invisible
in every log. It now writes its own `BLOCK` decision line.

`core/l0-fault-codes.ts` declares the letters once; the shim's `WP_FAULT=` values and `SHIM_LOG_FAULTS`
derive from it. The **producer** decides the fault (`C` in `configMissingBlock`, `Y` in
`checkConfigSync`) and `BlockedResult` carries it — the adapter never scrapes report text.
`audit-fault-stamp.spec.ts` drives the partition from `L0_FAULTS`, so an eighth fault with no emitter
fails the build.

---

## 3. Open items, in priority order

### (1) The `misplacedCd` row — the immediate follow-up

`main` added `misplacedCdBlock` to `runner.ts` **without adding a row to the L1 table.** So it is an L1
block with no row in `L1_ROWS`, and `guards/L1-location.md` still says *"Rows 3 and 5 are the two
structural blocks"* while `l1LocationBlock` chains **three**.

This PR **locks that contradiction rather than fixing it**, to keep the empty-diff proof above. It is
recorded as a `KNOWN GAP` comment over `l1LocationBlock`.

The reviewer pushed back on exactly this, and the push is fair: *the deferral is defensible once, the
byte-lock cementing the false sentence is not.* So the follow-up is not optional. It adds the row to
`L1_ROWS` and the doc together in one change — the first real demonstration of the workflow the lock
exists to enable.

### (2) The reviewer's other two notes

- **Only fault `C` is proven end-to-end from its producer.** Nothing asserts each *enforcement site*
  passes its own letter, so a future L0 block could land `fault=-` silently.
- **`hook-core.ts:290`'s log reason under-describes the widened `S`** — it names only the shim half, but
  main widened `S` to cover the whole managed hook surface (both `.sh` files plus the
  `.claude/settings.json` registration).

### (3) Row 2 — `TreeKind 'outside'` (pre-existing; do NOT "fix" casually)

`'outside'` is consumed nowhere, so a `git` command from `/tmp` is force-to-root blocked **today**.
`L1Classification.forEnforcement` maps `outside → p` deliberately, with a test pinning it. Classifying
it honestly as `o` would make row 2's `→ L2` real and **silently disarm force-to-root outside any repo.**
The doc's own "Not done" section is about this. It ships together with target-based jurisdiction, or
not at all.

---

## 4. The larger roadmap this belongs to

`GUARD_MATRIX.md` is the index; per-layer docs live in `guards/`. The project converts each layer from
hand-written prose into **an ordered array in code that the guard actually consults**, rendered into its
doc and byte-locked — so the doc cannot describe a guard the code does not implement, and each row's
`useCases[]` accumulates edge cases as executable knowledge instead of prose.

| layer | status |
|---|---|
| L0 tooling integrity | generated + byte-locked (pre-existing) |
| **L1 location** | **this PR** |
| L2 branch state | spec merged in #578 (`guards/L2-branch-state.md`, 10-row table). `L2_ROWS` **not built** |
| L3 branch cleanup, L4 PR lifecycle | stubs |

Also designed but not built: a **global allowlist** (inert commands + universal cures) consulted before
every layer — described in `GUARD_MATRIX.md`, no code. Note `pwd` IS already in `L0_ALLOWLIST` with
`cure=false`, so it survives a fault but does not bypass L1. And **`configKeyForRule()`** to collapse the
nine `hookGuards` config keys to one per layer — blocked because `rule.name` IS the config key in eleven
places, and `checkConfigSync` blocks every Write/Edit/Bash if a loaded rule has no key.

---

## 5. How to work on this — hard-won, do not relearn

**Work in the PRIMARY clone with `git checkout -b`. Do NOT create a worktree for coordinator work.**
The coordinator's `CLAUDE_PROJECT_DIR` is fixed at session start and does not follow a `cd`, so a
coordinator in a worktree has its files in one tree and its guards in another. L1 row 3 now blocks this.
Worktrees are for **subagents** (`isolation: "worktree"`), which get their own `CLAUDE_PROJECT_DIR`.

**Spawn `backwards-compat-reviewer` as its OWN agent type.** The gate matches on the subagent's *type*
via transcript provenance — a `general-purpose` agent told to act as the reviewer does **not** satisfy
it, and `provenance.json` reads `reviewers: []`.

**Run `npx vitest run packages/tooling/rules-config` DIRECTLY after touching any `.md`.** nx caches
`rules-config:ci` and a root markdown file is not an input to it, so `build-all` can be green while
`sync-flow-guidance.spec.ts` is red. That spec rejects an imperative verb followed by a BARE `wp-*` bin
— always write `pnpm wp-x`. A doc PR landed a red `main` exactly this way.

**Run vitest from the REPO ROOT.** From inside a package it prints "No test files found" and exits 0 — a
false green that fooled a reviewer.

**`ai-hook-rules:test` is genuinely flaky** — nine occurrences across unrelated branches in one day, nx
flags it itself, and it passes standalone every time. Re-run before believing a red.

**`main` moves fast.** Re-read files before planning against them; several plans in this project were
built on a stale view. `git rebase` is blocked — sync via `pnpm wp-start-upsert-pr` (PR open) or
`pnpm wp-start-update` (no PR).

**The L0 allowlist is anchored to the WHOLE command.** Appending `&& echo done` to an allowlisted cure
turns it into a non-match and the block repeats.

---

## 6. Related backlog

- `../webpieces-ts50/backlog/bug-merge-in-progress-guard-has-no-abandon-path-and-its-marker-leaks-across-branches.md`
  — written during this work; asks for an independent competing opinion. Came out of #579 being
  unabandonable mid-merge, which is why it had to be closed rather than resolved.
- The target-based jurisdiction bug (Bash guards judge the shell cwd, not the paths the command touches)
  — item (3) above depends on it.
