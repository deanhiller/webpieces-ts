# BUG: stage ② tells the AI to write `review.json` *while* the reviewers run — so any reviewer that reads it either finds nothing or reads the **previous run's** file

**Package:** `@webpieces/pr-gate`
**Version seen:** `0.4.526` / `0.4.530` (the ordering predates both — it is in `ReviewReport.render()` as first written)
**Severity:** Medium-High — the race is silent in the safe direction and **wrong in the unsafe one**.
A reviewer that reads a missing `review.json` returns a false RED and costs a wasted reviewer run.
A reviewer that reads a **stale** `review.json` left over from an earlier run on the same branch
returns a false GREEN against a title that no longer exists — and nothing in the output says which
happened.

**Source:**
- `packages/tooling/pr-gate/src/scripts/workflow/review-report.ts:59-63` (`render()` — the ordering)
- `packages/tooling/pr-gate/src/scripts/workflow/review-report.ts:88-96` (`nextSteps()` — the instruction)
- `packages/tooling/pr-gate/src/scripts/workflow/review-report.ts:118-125` (the spawn blocks, printed first)

## The bug

`render()` prints the spawn blocks and *then* the numbered next-steps:

```ts
render(input: ReviewReportInput): string {
    return '\n' + SEP + this.header(input) + SEP + '\n'
        + this.checklistSection(input)     // ← "Spawn these N reviewer subagent(s)"
        + this.nextSteps(input.reviewPath); // ← "STEP 1 — ... write the review file"
}
```

and `nextSteps()` states the concurrency explicitly:

```ts
'STEP 1 — review your own changes, then write the review file (finish REFUSES without it).\n' +
'         Do this WHILE any reviewer subagents above are still running:\n\n' +
```

The comment above `nextSteps()` says it is "numbered rather than prose-linked … so that skipping
step 1 is visibly skipping a step." The numbering is fine. The problem is the **`WHILE`**: it does
not merely permit the AI to spawn first, it *instructs* it to. Every AI that follows this literally
spawns the reviewers and only then starts writing `review.json`.

That is correct for every reviewer webpieces has shipped so far, because they all read
`pr-context.json` and the materialized diff — artifacts that exist *before* stage ② prints. It stops
being correct the moment a consumer writes a checklist that reasons about the PR's **stated intent**
rather than its diff, and `review.json` is the only place that intent lives.

### Why the stale case is the dangerous one

`.webpieces/pr-review/<branch>/review.json` is **not** cleared between runs of
`wp-review-upsert-pr`. On any second run on the same branch — a fixed build, an amended commit, a
re-review after new commits — the file from the previous run is sitting there. So the two orderings
produce genuinely different failures:

| When the reviewer reads it | Outcome |
|---|---|
| First run on the branch, reviewer wins the race | File absent → reviewer reports RED "no review.json yet" → correct-ish, but a wasted reviewer run and a confusing message |
| Re-run on the branch, reviewer wins the race | File present but **stale** → reviewer validates last run's title, summary and risk level → **false GREEN on content that no longer exists** |

The second row is the reason this is worth fixing rather than documenting. There is no signal
anywhere — not in the verdict, not on the dashboard — distinguishing "reviewed the current
`review.json`" from "reviewed the one from twenty minutes ago."

## Measurement

Consuming repo: **`/Users/deanhiller/workspace/onetablet/monorepo-nx2`** (an AI can read it directly).

That repo added a patternless checklist, `morpheus-linear-required`
(`.claude/agents/morpheus-linear-required.md`, `.claude/review/morpheus-linear-required.md`, wired
into `commands.pr-gate.checklists` with no `patterns`). Its job is to refuse any PR whose title does
not name an in-cycle Linear ticket. The title it must judge is `review.json`'s `title` field —
deliberately, because that is the exact string `wp-finish-upsert-pr` puts on the GitHub PR, so
checking it catches the problem *before* a PR exists.

Being patternless, it runs on **every** PR. Following stage ②'s printed instruction literally
therefore produces a guaranteed race on every single PR in that repo, forever.

The consumer's workaround was to add a rule to its own `AGENTS.md` telling the AI to **contradict**
the gate's printed instruction:

> **Write `review.json` BEFORE spawning reviewers, not alongside them.** The gate says to write it
> while they run, but `morpheus-linear-required` runs on EVERY PR and reviews the `title` field of
> that very file — so spawning it first guarantees a wasted red round-trip.

A consuming repo having to instruct its agents to disobey the tool's own output is the smell. Note
also that the agent file itself had to carry a special-case recovery ("if `review.json` is missing
that is RED, and here is why it might legitimately not exist yet") purely to absorb this race — a
paragraph that would be unnecessary if the ordering were right.

## Suggested fix

### 1. Reorder and reword (the real fix, ~10 lines)

Print the write-`review.json` step **before** the spawn blocks, and drop the `WHILE`:

```ts
render(input: ReviewReportInput): string {
    return '\n' + SEP + this.header(input) + SEP + '\n'
        + this.writeReviewJsonFirst(input.reviewPath)  // was STEP 1, now printed first
        + this.checklistSection(input)                  // "now spawn these N reviewers"
        + this.finishStep();                            // "then run wp-finish-upsert-pr"
}
```

Wording that keeps the current "skipping a step is visible" property while fixing the dependency:

```
STEP 1 — write review.json (finish REFUSES without it, and a reviewer may need to read it).
STEP 2 — spawn these N reviewer subagent(s), one each, in parallel.
STEP 3 — run: pnpm wp-finish-upsert-pr
```

This costs nothing in wall-clock terms that matters: writing `review.json` is one file write by the
orchestrating AI, not a subagent round-trip. The `WHILE` was optimizing a few seconds of overlap at
the cost of correctness.

### 2. Clear or version the stale file (independent, and worth doing regardless)

Even with the ordering fixed, a reviewer spawned before the AI finishes writing can still read a
stale file. Options, in increasing intrusiveness — this report does not pick one, since it is a
product call:

| Option | Cost |
|---|---|
| `wp-review-upsert-pr` deletes `review.json` at the start of stage ② | Loses a legitimately-reusable review when the AI is only re-running for one new reviewer |
| Stamp `review.json` with the head sha it was written against; a reviewer (and `wp-finish-upsert-pr`) rejects one whose sha ≠ current HEAD | One new field; catches both the stale-read AND a `review.json` describing an older commit, which is a real problem today independent of this bug |
| Pass the `title`/`summary` into the reviewer briefing (`ReviewerBriefing`) so reviewers never read the file directly | Removes the race for content the gate already knows, but `ReviewerInstructionsService` would need the review content, which does not exist yet at briefing time — circular unless (1) is done first |

The sha stamp is the one that pays for itself: `wp-finish-upsert-pr` currently accepts a
`review.json` written against any commit, so an AI that reviews, then commits three more times, then
finishes, ships a review of code that is no longer in the PR.

## Notes for whoever fixes it

- **`ChecklistReviewContext` is the natural carrier** if you go the briefing route
  (`packages/tooling/rules-config/src/review-json.ts`). It already exists precisely to hand reviewers
  "the per-PR facts every reviewer needs GIVEN to it, alongside its own checklist" rather than making
  them go read files — the same reasoning applies to the review content itself.
- **Do not fix this by telling consumers not to write such checklists.** A checklist that reads the
  PR's stated intent is a legitimate and useful shape: "does the summary match the diff", "does the
  title follow the team's convention", "is the risk level honest given what changed". The Linear-key
  case is just the first one built.
- **The `header()` text needs to change too** (`review-report.ts:68-70`): it currently reads
  "② Spawn Subagent Reviews, then finish", which will be one step out of date after the reorder.
- **Regression test:** a repo with a patternless checklist, on a branch with an EXISTING
  `review.json` from a prior run, must not let a reviewer read the prior file. Assert the stale case
  specifically — the missing-file case is the one that is easy to test and the one that is already
  survivable.
