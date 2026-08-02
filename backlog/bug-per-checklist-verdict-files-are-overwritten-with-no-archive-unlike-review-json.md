# BUG: re-running a reviewer overwrites `review-<id>.json` with no archive — the refusal that blocked the PR disappears

**Package:** `@webpieces/rules-config` (consumed by `@webpieces/pr-gate`)
**Version seen:** `0.4.535`
**Severity:** Medium — nothing breaks, but the only durable record that a gate ever refused a PR is
destroyed by the act of fixing what it refused. A repo cannot answer "did any checklist ever block
this branch, and for what?" from its own working tree.

**Source:**
- `packages/tooling/rules-config/src/review-json.ts:389` — `checklistResultPath`, a fixed path with no archive counterpart
- `packages/tooling/rules-config/src/review-json.ts:262` — `archiveReviewJson`, the treatment `review.json` already gets
- `packages/tooling/rules-config/src/review-json.ts:212` — `OLD_REVIEW_FILE`, the single-slot convention to copy

## The bug

Every reviewer writes its verdict to one fixed path:

```ts
checklistResultPath(reviewJsonFilePath: string, checklistId: string): string   // :389
```

Nothing moves, copies, or versions that file. A re-run of the same reviewer writes straight over it.

So the normal, healthy workflow — reviewer refuses → author fixes the problem → reviewer re-runs and
passes — **erases the refusal**. Afterwards the tree contains a green verdict and no evidence that
anything was ever red. That is exactly backwards: the refusal is the interesting event, and the pass
is the expected one.

## The asymmetry is the argument

`review.json`, the sibling file in the same directory, already has this solved. `archiveReviewJson`
(`:262`) moves it to `old-review.json` (`:212`) once a PR consumes it, and the doc comment explains
why in terms that apply verbatim to verdict files:

> "The point is the MOVE, not the copy. … Moving it means the only way to reach finish again is to
> write a fresh one, and `loadReviewJson` points at the archive when it is missing so the archive
> reads as an audit trail rather than as a lost file."

One file in `.webpieces/pr-review/<branch>/` keeps one generation of history. Its siblings keep none.

## Measurement

Consuming repo: **`/Users/deanhiller/workspace/onetablet/monorepo-nx2`** (an AI can read it directly).
Two occurrences on 2026-08-01, both on a patternless BLOCK checklist
(`morpheus-wrapper-linear-required`), both losing a verdict that had genuinely refused a PR:

1. Branch `dean/morpheus-wrapper-rename`. First run: `status:"red"` — the PR title named no Linear
   ticket, and `wp-finish-upsert-pr` correctly refused to open a PR. A ticket was then created and
   the title corrected; the reviewer re-ran and wrote `status:"green"` **to the same path**. The red
   verdict, including the reviewer's reasoning, no longer exists anywhere in the repo. The PR body
   records the eventual green only.
2. Branch `dean/agents-md-obey-webpieces`. First run: `status:"red"` on an acceptance criterion the
   author had not recorded. The author recorded it, the reviewer re-ran, wrote green — same path,
   same loss. This one was a real defect the gate caught and there is now no trace of it having been
   caught.

In both cases the gate did its job perfectly and then deleted the proof.

## Suggested fix — one slot back, mirroring `review.json`

Do exactly what `review.json` does, no more: **before a verdict file is replaced, move it to
`review-<id>.json.old`.** One generation, always the same path, so it can never be mistaken for a
series that means something.

```ts
// packages/tooling/rules-config/src/review-json.ts
oldChecklistResultPath(reviewJsonFilePath: string, checklistId: string): string {
    return `${this.checklistResultPath(reviewJsonFilePath, checklistId)}.old`;
}

/** Retire the verdict a reviewer is about to replace. Returns the archive path, or '' if none. */
archiveChecklistResult(reviewJsonFilePath: string, checklistId: string): string { … }
```

**Where to call it: `wp-finish-upsert-pr`, on the refusal itself.** The verdict file is written by
the reviewer subagent, not by webpieces, so there is no write to intercept — but there is no need for
one. The moment webpieces *acts on* a red verdict is the moment to retire it:

> When `wp-finish-upsert-pr` refuses the PR because a checklist is `CK_FAIL`, **move that verdict to
> `review-<id>.json.old`** and then fail back to the AI telling it to produce a fresh verdict that
> passes.

This is safe by construction, and the reason is worth stating because it is what makes the rule
simple: **a red verdict is never reusable.** It always blocks, so nothing is lost by moving it —
unlike a green or yellow verdict, which stage ② deliberately reuses across finish attempts
("already reviewed on this branch (reusing its review-<id>.json)"). Archiving *only* on FAIL
therefore needs no test for whether a reviewer was re-instructed, and cannot interfere with reuse.

It also inherits `archiveReviewJson`'s central property — "the point is the MOVE, not the copy."
Once the red is moved, the only way to reach finish again is a **fresh** verdict from a real
reviewer run. There is no stale red left on the live path to be re-read, re-reported, or mistaken
for the current state.

Do **not** archive unconditionally at finish the way `review.json` does. `review.json` is authored
fresh each round by the orchestrator and is cheap; verdicts are expensive subagent runs, and
retiring a passing one would force a needless re-run.

**This pairs with the sibling report**
[`bug-a-refused-reviewer-reads-as-one-that-never-ran-because-an-earlier-assert-masks-the-fail-message`](./bug-a-refused-reviewer-reads-as-one-that-never-ran-because-an-earlier-assert-masks-the-fail-message.md),
and the two are best fixed together: that one makes the refusal *legible* (say which reviewer
refused and quote its finding, instead of "you MUST run these N subagent(s)"), this one makes it
*durable* (keep the refusal on disk instead of letting the fix erase it). Fixing only the first
leaves no record; fixing only the second leaves a record nobody is told about.

After the move, the same finish run should tell the AI plainly: this checklist REFUSED, here is what
it wrote, its verdict has been retired to `review-<id>.json.old`, and a fresh reviewer run is
required — fix the finding first, or obtain a human override.

## Notes for whoever fixes it

- **`.old` must never be read back as a verdict.** `loadChecklistResults` (`:483`) iterates required
  checklists by id; keep it reading only the exact `review-<id>.json` name so an archived refusal can
  never resolve as a live verdict.
- **Consider stamping the archived body**, as `archivedBody` already does for `review.json` — a
  one-line note saying which run it came from turns the file from a mystery into a trail.
- **The dashboard could surface it cheaply**: if `review-<id>.json.old` exists and was red, the
  checklist comment can note "previously refused, re-reviewed" — which is the fact a human reviewer
  most wants and currently cannot get.
- **The move happens on the refusing run, so finish must stay re-runnable.** `archiveReviewJson` is
  called "only after the PR is actually up: a finish that failed before publishing must stay
  re-runnable." The mirror of that here is: move the red only once the refusal is definitely being
  reported, and make sure a finish that dies *after* the move still leaves the branch in a state the
  AI can act on — the `.old` file plus a message naming the reviewer, not a silent gap.
- **Regression test:** given an existing red `review-<id>.json`, a refusing `wp-finish-upsert-pr` must
  leave a `review-<id>.json.old` containing the red verdict and no live `review-<id>.json`; a second
  red-then-refuse cycle must overwrite the `.old` rather than accumulate `.old.old`. Assert the
  second part explicitly — one slot is the design, and an accumulating series is the failure mode
  this avoids. Assert too that a **green** verdict is left untouched, since that is the case reuse
  depends on.
