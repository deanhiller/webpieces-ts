# FEATURE: `/audit-webpieces` cannot say whether the time went to Dean, CI, a build, a shut laptop, or the AI

**Package:** `.claude/skills/audit-webpieces` (`scripts/wp_audit.py`, `scripts/digest.py`, `SKILL.md`)
**Requested by:** Dean, verbally
**Why it matters:** the one question the audit exists to answer — *"what is making my work take so long?"* — is the one question it currently cannot answer, because the collector **throws the evidence away** before anything gets to look at it.

## The defect, quoted from source

`.claude/skills/audit-webpieces/scripts/wp_audit.py`, `_scan_session`:

```python
if 0 < gap <= 300:
    active_seconds += gap
```

**Any gap over five minutes is DISCARDED, not attributed.** A ten-minute human answer, a closed
laptop, a Claude API outage and a twelve-minute CI run all vanish into the same nothing, and they
vanish *identically* — so nothing downstream can tell them apart, or even tell that they happened.

The number that survives, `active_seconds`, then looks tidy precisely because the awkward part was
deleted. That is worse than a missing metric: it is a metric that reads as complete. A session that
was 90% Dean-at-lunch and a session that was 90% agent-thrash produce the same `active_hours`, and
the report presents both with the same confidence.

The token side has no such hole — `retbytes` (#742) measures context cost accurately, from the
transcripts, retroactively. **This is strictly about TIME attribution.** Nothing about the byte
accounting needs to change.

## The partial precedent already in the file

The intent is already there, once, as a special case. `AskUserQuestion` is excluded from
`error_seconds`, with this comment:

> *A prompt the human declined or left sitting is HUMAN latency, not AI waste... One 109-minute
> `AskUserQuestion` once accounted for 43% of the fleet's whole "failed call" time and made the top
> finding a measurement artifact.*

So the failure mode is known and has already produced one wrong headline finding. What exists is
one hand-placed exclusion for one tool. **What does not exist is the general mechanism**: a model
that says where every second went, rather than a list of seconds we have agreed not to blame the AI
for.

## Why it matters right now

Two live cases, both of which the current collector leaves unresolvable:

- `backlog/bug-parallel-subagents-in-worktrees-collapse-the-build-gate.md` reconstructed its whole
  case **by hand** — "18 minutes alone vs ~59 minutes with seven siblings", "burned ~46 minutes
  almost entirely in `sleep`", "green in 58 seconds with no code change" — by reading eight
  transcripts directly. That is an enormous amount of manual work to produce numbers a collector
  should emit, and it is exactly the kind of reading this skill's own volume rule forbids.
- A framework-upgrade backlog file measured **185.4k tokens** of reviewer cost and concluded the
  reviewers are the problem — but the same run took only **71 seconds** of agent time. Tokens and
  minutes are different currencies, and nobody can currently tell whether an upgrade's *minutes*
  are human, CI, build or AI. So there is no way to know whether the fix proposed there addresses
  the actual cost, or a cost nobody is paying.

## The ask

A `cycletime` subcommand that attributes **every** second, with two laws:

**1. ATTRIBUTE, NEVER DROP.** Every second between a session's first and last row lands in exactly
one bucket:

| Bucket | Identified by | Source | Quality |
|---|---|---|---|
| `HUMAN` | assistant turn ending → next user message; plus `AskUserQuestion` durations | transcript | exact — the assistant→user boundary is a fact |
| `MACHINE_ASLEEP` | `Sleep` → `Wake` | `pmset -g log` | exact, and needs no instrumentation |
| `CI` | check-run `startedAt`/`completedAt` | `gh pr checks` | exact |
| `LOCAL_BUILD` | `took=` rows | `~/.webpieces/builds.log` via `builds_ledger.py` | exact |
| `REVIEWER` | Agent spawn → return | transcript | exact |
| `WEBPIECES_TOOLING` | `wp-*` Bash duration minus the build inside it | transcript + ledger | good |
| `CLAUDE_OUTAGE` | api-error rows, and in-turn stalls with no tool pending | transcript | good |
| `AI` | **the residual** | subtraction | only as good as the seven above |

**2. AI IS THE RESIDUAL.** Seven buckets measured, AI left over. Inverted — AI measured and
something else residual — the residual absorbs every measurement error and every unavailable
source, and **the agent gets blamed for a closed laptop lid.** `pmset -g log` is the piece nobody
had, and it is the honest answer to "take the computer close/open time out of my numbers". It is a
rolling buffer of days to weeks, so a long window can outrun it — report the covered fraction, the
same way `ledger_earliest_row` / `window_starts_before_ledger` already do for the build ledger.

Plus:

- **A phase timeline** — `branch created → wp-start-upsert-pr → wp-review-upsert-pr →
  wp-finish-upsert-pr → wp-land-pr`. Every boundary is already a timestamped Bash call in the
  transcript, so this needs no new logging at all.
- **Wall-clock AND blocking, per phase.** They differ and the difference is the point:
  `wp-finish-upsert-pr` arms auto-merge, so the agent reports and stops while CI runs on. That CI
  time is wall-clock but not blocking, and reporting only wall-clock invoices Dean for time he is
  not paying. Each phase also attributed across the buckets — *"phase 2 took 14 min: 11 CI, 2 local
  build, 1 AI"* is the sentence this whole feature exists to produce.
- **p50/p75/p95/p99 with `n` printed, and a floor.** Over a week across thirteen repos there may be
  a handful of complete branch→land cycles. p99 on n=6 is the maximum wearing a hat. Below a stated
  floor, refuse the percentile out loud rather than emitting a meaningless number quietly.

## The invariant that makes it trustworthy

**Randomly sample sessions and assert `sum(buckets) == wall_clock`**, and emit the result as a
`reconciliation` block: sessions sampled, worst absolute drift, worst percentage drift, and a
pass/fail against a stated tolerance.

This is the deliverable, not a nicety. A report whose buckets do not sum to the clock must **say so
loudly** rather than printing confident percentages over a total that is quietly missing an hour.
If they do not sum, the model is wrong, and Dean must be able to SEE that it is wrong — the current
300-second cap is exactly what a model looks like when it makes itself look right by discarding
what it cannot explain.

## What is NOT broken

- **The token accounting.** `retbytes` measures context cost correctly and needs nothing here.
- **The existing `transcripts` numbers.** `active_seconds`, redundant builds, blocked-call cost and
  the tool histogram all answer their own questions fine. `cycletime` is an addition beside them,
  not a replacement; the 300s cap stays where it is, doing what it was written to do.
- **The one-pass rule.** Whatever collects this must ride on the SAME transcript walk, the way the
  `retbytes` accumulator does. Opening every session a second time to ask a second question about
  it is the exact antipattern this skill exists to measure.
