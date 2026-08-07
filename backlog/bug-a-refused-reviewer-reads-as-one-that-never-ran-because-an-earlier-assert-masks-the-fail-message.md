# BUG: a reviewer that REFUSED reads as one that never ran — `assertEveryReviewerRan` throws one line before the message that would say so

**Package:** `@webpieces/pr-gate` (message lives in `@webpieces/rules-config`)
**Version seen:** `0.4.535` (present since the assert was added)
**Severity:** Medium-High — the correct message already exists and is **unreachable**. An AI reading
the output re-spawns a reviewer that already refused, gets refused again, and loops — burning a full
reviewer run per iteration — while the reviewer's actual finding is never shown to anyone.

**Source:**
- `packages/tooling/pr-gate/src/scripts/commands/finish-upsert-pr-command.ts:123` — the assert that throws
- `packages/tooling/pr-gate/src/scripts/commands/finish-upsert-pr-command.ts:124` — the call that would have produced the right message
- `packages/tooling/pr-gate/src/scripts/commands/finish-upsert-pr-command.ts:260` — `assertEveryReviewerRan`
- `packages/tooling/pr-gate/src/scripts/commands/finish-upsert-pr-command.ts:337` — a comment asserting the opposite ordering
- `packages/tooling/rules-config/src/review-json.ts:467` — `pendingChecklists`, where FAIL and MISSING merge
- `packages/tooling/rules-config/src/review-json.ts:529` — the FAIL message that never prints

## The bug

Two consecutive lines, in this order:

```ts
this.assertEveryReviewerRan(scan);                                      // :123  ← throws
const review = this.reviewJsonService.loadReviewJson(reviewJsonPath(…), required);  // :124  ← never reached
```

`assertEveryReviewerRan` refuses on `scan.outstanding`, which comes from `pendingChecklists`
(`review-json.ts:467`):

```ts
return status !== CK_PASS && status !== CK_WARN && status !== CK_OVERRIDDEN;
```

`CK_FAIL` (the reviewer ran and **refused**) and `CK_MISSING` (the reviewer **never ran**) both
satisfy that predicate, so they land in the same bucket and produce the same message:

```
⛔ NO PR — 1 of 1 review checklist(s) that apply to this branch have no passing verdict yet: <name>

You MUST run these 1 reviewer subagent(s) — a SEPARATE one for each. …
      must write:   …/review-<id>.json
```

Meanwhile line 124 would have called `requiredChecklistErrors`, which has exactly the right branch
(`review-json.ts:529`):

```ts
if (verdict.status === CK_FAIL) {
    errors.push(`Checklist "${req.id}" FAILED review (status:"${VERDICT_RED}"). The reviewer (${req.subagent}) wrote:\n      ` + …
```

That message names the refusal **and quotes the reviewer's own finding**. It cannot print while any
checklist is red, because the assert on the previous line always wins.

The codebase believes the opposite. `finish-upsert-pr-command.ts:337`:

```ts
// point is always PASS/OVERRIDDEN — loadReviewJson already threw on FAIL/MISSING.)
```

`loadReviewJson` never gets the chance; `assertEveryReviewerRan` throws first.

## Why "you MUST run it" is the damaging wording, not just an imprecise one

The instruction block is an imperative to spawn subagents. Handed to an agent, the literal, obedient
response is to spawn the reviewer again. The reviewer re-reads the same unchanged state, refuses
again, and the loop repeats — each pass costing one full subagent run. Nothing in the output
suggests the correct action, which is to **fix the finding or obtain a human override**, because the
finding is not in the output at all.

This is the same failure the file already fixes for a *different* status. `assertEveryReviewerRan`
(`:260`) special-cases unreadable verdict files precisely so they are not mistaken for absent ones,
with this reasoning in the code:

> "Unreadable verdict files come FIRST. A reviewer that wrote its verdict in the removed `success`
> format is otherwise indistinguishable from one that never ran, and the AI would go re-run a
> subagent instead of correcting four characters of JSON."

`CK_BAD_FORMAT` got that treatment. `CK_FAIL` did not, and it is the more common case — every
deliberate refusal by a BLOCK checklist lands here.

## Measurement

Consuming repo: **`/Users/deanhiller/workspace/acme/consumer-monorepo2`** (an AI can read it directly).

That repo runs a patternless checklist, `ticket-key-required`, that refuses any PR whose
title does not name an in-cycle Linear ticket. Observed twice on 2026-07-31/08-01:

1. PR branch `dean/ticket-key-checklist-rename`, deliberately opened with no ticket key. The reviewer
   wrote `review-ticket-key-required.json` with `status: "red"`, `override: ""`, and an
   `output` naming gate 1 and quoting the offending title.
2. `pnpm wp-finish-upsert-pr` printed `⛔ NO PR — … have no passing verdict yet` followed by
   `You MUST run these 1 reviewer subagent(s)`, listing the verdict file the reviewer had **already
   written**, with no mention of red, no mention of a refusal, and none of the reviewer's text.
3. `gh pr list --head dean/ticket-key-checklist-rename` → `[]`. The refusal itself worked correctly; only
   the reporting was wrong.

The second occurrence was a genuine (not staged) refusal on an unmet acceptance criterion, with the
identical output.

## Suggested fix

Smallest correct change: teach `assertEveryReviewerRan` the distinction it already has the data for.
Split `scan.outstanding` by resolved status and lead with refusals, reusing the existing message
rather than writing a second one:

```ts
private assertEveryReviewerRan(scan: ChecklistScan): void {
    if (scan.outstanding.length === 0) return;

    const refused = scan.outstanding.filter(r => this.reviewJsonService.resolveVerdict(r, scan.results).status === CK_FAIL);
    const neverRan = scan.outstanding.filter(r => !refused.includes(r));

    // A refusal is a RESULT, not a missing step. Never tell the caller to re-run a reviewer that
    // already answered — it will answer the same way, and the answer is already on disk.
    …refused → "REFUSED by <subagent>: <verdict.detail>. Fix the finding, or have a HUMAN authorize
                an override recorded in that reviewer's `override` field. Do NOT re-spawn it."
    …neverRan → the existing "You MUST run these …" block, listing ONLY these
}
```

Ordering inside the message should be: unreadable (already first) → refused → never ran. Each is a
different action by the reader, and only the last one is "spawn a subagent."

Alternative, if a larger change is acceptable: move `loadReviewJson` (`:124`) **above** the assert so
`requiredChecklistErrors` reports FAIL with the reviewer's text, and reduce the assert to MISSING and
BAD_FORMAT only. This removes the duplicated concept rather than teaching it twice, but it changes
which error surfaces when review.json is *also* malformed, so it needs a decision about precedence.

## Notes for whoever fixes it

- **Fix the comment at `:337` in the same pass.** "loadReviewJson already threw on FAIL/MISSING" is
  false today and is what makes the current ordering look deliberate.
- **`wp-review-upsert-pr` has the same shape** and should be checked: a reviewer that refused on a
  previous round is listed as owed there too, so stage ② re-instructs it identically.
- **Regression test:** a branch with one BLOCK checklist whose verdict file exists with
  `status:"red"` and empty `override` must produce output that (a) contains the reviewer's `output`
  text and (b) does **not** contain the "You MUST run these N reviewer subagent(s)" imperative for
  that checklist. Assert both, since asserting only (a) still permits the loop-inducing instruction
  to appear alongside it.
- The distinction matters more as consumers adopt always-run BLOCK checklists: for a patternless
  gate, every refusal on every PR takes this path.
