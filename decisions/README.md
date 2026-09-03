# decisions/

Long-form records of the **hard, cross-cutting problems** in this tooling — the ones that took
measurement to understand and that we will otherwise re-derive (wrongly) every six months.

## What belongs here, and what does not

| | goes in | example |
|---|---|---|
| **`guards/L*.md`** | the DECISION TABLE the engine consults — rows, dimensions, actions, cures | "K=`w` + A=`c` → BLOCK_AI_CURE" |
| **`decisions/`** | WHY the model is shaped that way — the measurements, the edge cases, the options rejected | "why a nested worktree resolves `node_modules` differently from a sibling one" |
| **a GitHub issue** | one incident or one feature, filed and eventually closed | [#768](https://github.com/deanhiller/webpieces-ts/issues/768) — "feature-branch-guard judges a subagent verdict write against the primary clone's live branch" |

A GitHub issue describes **one** failure. A `decisions/` doc describes the **axis** several
failures share, and survives after each of them is fixed. (Until 2026-09 those issues lived in a
tracked `backlog/` directory; all 87 were migrated to GitHub issues and the directory deleted, because
a tracked file cannot be closed, assigned, or referenced from a PR.)

## Rules

1. **Measure, don't assert.** Every claim about git, Node resolution or the harness carries the
   command that produced it, so the next reader can re-run it instead of trusting it. Several
   entries here exist *because* a plausible assertion turned out to be false.
2. **Record what was rejected, and why.** The rejected option is the one that gets re-proposed.
3. **Date the measurements.** Behaviour changes; a measured table with no date is a liability.
4. **Cross-link.** Point at the `guards/L*.md` row, the GitHub issue for the incident, and the source file
   that implements the decision. Code comments should point back here by path.

## Index

| # | doc | axis | status |
|---|---|---|---|
| 0001 | [tree-identity-and-governance.md](0001-tree-identity-and-governance.md) | Which tree governs a tool call — and which release, which state dir, which log file follow from that | D2, D5 taken; **D1 REVERSED (2026-08-07) — state stays in `{repo}/.webpieces`, so D4/D6 are moot with it**; D7 withdrawn; identity #4 is log-naming only (2026-08-10) |
| 0002 | [the-shim-cannot-follow-the-tree.md](0002-the-shim-cannot-follow-the-tree.md) | The committed hook entry point is always the primary's, so a worktree can never be governed by its own release | problem statement, and it stands; **SUPERSEDED (2026-08-10) — the constraint is ACCEPTED: one governor per repo** |
| 0003 | [three-hooks-per-tree-governance.md](0003-three-hooks-per-tree-governance.md) | One absolute fail-closed hook + two **relative** hooks, so each tree runs its own shim | **⛔ SUPERSEDED / REVERSED (2026-08-10)** — the relative form never ran a worktree's own release, so both hooks are ABSOLUTE, L-1 `guarantee-root.sh` is deleted, and skew is blocked by L1 `trinary-version-skew` |
| 0004 | [pr-artifacts-are-machine-global.md](0004-pr-artifacts-are-machine-global.md) | An artifact belongs to the scope of the fact it describes — the gated PR merge body is keyed by the PR, not by the tree that rendered it | **SUPERSEDED by 0005** (the rule survives; the machine-global mechanism does not) |
| 0005 | [the-pr-description-is-the-merge-body.md](0005-the-pr-description-is-the-merge-body.md) | GitHub holds the gated commit body, so there is no machine-global store — `~/.webpieces` is retired and state is only `{repo}/.webpieces` | taken + implemented |
