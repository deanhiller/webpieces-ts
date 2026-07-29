# Webpieces review checklists — how to satisfy them

Your repo defines company review checklists in ONE manifest doc (pointed at by
`pr-gate.checklists.doc` in `webpieces.config.json`). Each checklist names a reviewer **subagent**
(a `.claude/agents/<subagent>.md`) and, optionally, a detail doc and path `patterns`.

`wp-start-upsert-pr` printed which checklists your diff **matched** (by path). Matching is deliberately
**coarse** — the reviewer subagent makes the fine, content-level judgment by reading the actual diff.

The changed files + the exact base sha the gate uses are in
`.webpieces/pr-review/<branch>/pr-context.json`:

```json
{ "base": "<merge-base sha>", "head": "<HEAD sha>", "changedFiles": ["path/a.ts", "db/003.sql", ...] }
```

For EACH matched checklist you must:

1. **Spawn its named subagent as a SEPARATE subagent** — a *different* one per checklist. The coding
   agent may **not** review its own work, and one reviewer may **not** stand in for several. `wp-finish`
   verifies from the harness's own records that each distinct reviewer actually ran on this branch.
2. Have that subagent **read its doc, then inspect the real diff** of the changed files it cares about —
   `git diff <base> HEAD -- <file>` (base is in `pr-context.json`) — and decide whether the change
   satisfies the checklist. (A path-coarse checklist like "new API/queues" simply reports
   `success: true` when the diffs add no new route/queue.)
3. Have it **write its verdict** to `.webpieces/pr-review/<branch>/review-<id>.json` (one file per
   checklist, so concurrent reviewers never clobber each other). `<id>` is the subagent name.

## `review-<id>.json` (each reviewer subagent writes its own)

```json
{
  "id": "<the checklist id / subagent name>",
  "success": true,
  "output": "what you checked and what you found",
  "override": ""
}
```

- `success: true` → the checklist passes.
- `success: false` with an empty `override` → **`wp-finish` refuses to open the PR** and prints your `output`.
- `success: false` with a non-empty `override` → ships anyway as **🟡 overridden**; the `override`
  justification is surfaced on the PR. Use this only to deliberately, visibly accept a known issue.

## `review.json` (you, the main agent, write this once)

```json
{
  "title": "concise PR title (imperative, no branch names)",
  "riskScore": 0,
  "riskLevel": "green | yellow | red",
  "summary": "5–10 sentence review summary",
  "violations": ["pattern/architecture violations (empty array if none)"],
  "risks": ["notable risks (empty array if none)"],
  "filesToReview": ["paths a human should look at (empty array if none)"]
}
```

Then run `pnpm wp-finish-upsert-pr`. It re-computes the matched checklists, requires a well-formed,
passing (or overridden) `review-<id>.json` for each, verifies each distinct reviewer subagent ran, and
only then opens/updates the PR.

> Provenance is verified from Claude Code's own subagent records — it is not tamper-proof (a determined
> agent could forge a record), and outside a Claude Code session (plain terminal / CI) it can only warn,
> not verify. It raises the bar from "trust the model's word" to "deliberate, auditable forgery."
