# FEATURE: `review-<id>.json` records no model and no cost — though the transcript webpieces already opens carries both

**Package:** `@webpieces/rules-config` (schema in `review-json.ts`, read path in `subagent-provenance.ts`)
**Version seen:** `0.4.535` (consuming repo `monorepo-nx4`)
**Severity:** Medium — nothing breaks. But a repo cannot answer "what does a PR review cost?" or "which model reviewed this?" from gate artifacts, and the data is already in a file the gate parses on every run. Cost per PR is currently only recoverable by hand-parsing Claude Code internals.

## The gap

A verdict file has exactly four keys (`review-json.ts` → `verdictSchemaFor`):

```json
{ "id": "morpheus-wrapper-holistic", "status": "green", "output": "...", "override": "" }
```

Confirmed on a real run — every `review-*.json` in
`monorepo-nx4/.webpieces/pr-review/feature-ONE-2252-wp-evaluate-reviewers-skill/`
has `id, status, output, override` and nothing else.

So a repo running the gate cannot answer, from its own artifacts:

- **Which model reviewed this?** A checklist's `.claude/agents/<subagent>.md` declares `model:`, but that is the *configured* value, not what ran — and it can silently disagree (see the `morpheus-reviewer.md` case below).
- **What did this review cost?** Not recorded anywhere.
- **Is checklist X worth its price?** No per-checklist cost, so there is no basis to tune a roster, promote one reviewer to a stronger model, or retire a low-value one.

## Do NOT ask the subagent to self-report this

**This is the important design constraint, and webpieces already holds the right position on it.** `subagent-provenance.ts:74` states the principle in its own docstring:

> Verifies — from the Claude Code harness's OWN artifacts, never from anything the model asserts — that a subagent of a given `agentType` actually ran…

A model is unreliable about its own identity: it will confidently name a checkpoint it is not, report a family instead of a version, or repeat whatever the system prompt implied. Adding a `"model"` field to the verdict schema and asking the reviewer to fill it in would produce a field that is *usually* right and *silently* wrong — the worst kind of telemetry, because it looks authoritative and gets charted. Same for a token or cost self-estimate.

## The data is already in a file this code opens

`SubagentProvenanceService` reads, per reviewer:

```
~/.claude/projects/<cwd-slug>/<sessionId>/subagents/agent-<id>.meta.json   → { agentType, spawnDepth, … }
~/.claude/projects/<cwd-slug>/<sessionId>/subagents/agent-<id>.jsonl       → per-message records
```

It walks the `.jsonl` already, to compute `readDiff`, `readDoc`, `toolCallCount`, and `offRepoSearches`. **Every assistant record in that same file carries both fields needed:**

```jsonc
{ "message": {
    "model": "claude-sonnet-5",
    "usage": { "input_tokens": …, "output_tokens": …,
               "cache_creation_input_tokens": …, "cache_read_input_tokens": … } } }
```

Both are written by the harness, not by the model. Picking them up is **one more field-read inside the existing loop** — no new file, no new I/O, no self-report, and it inherits the anti-forgery property the class already documents.

## Measured, to show what this unlocks

Extracted by hand from the transcripts on two real gate runs in `monorepo-nx4` (PRs #780 and #781), priced at Opus 5 $5/$25 and Sonnet 5 $2/$10 per MTok, cache write 2× / cache read 0.1×:

| reviewer | model (from transcript) | PR #780 | PR #781 |
|---|---|---:|---:|
| `morpheus-wrapper-linear-required` | `claude-opus-5` | $2.02 | $1.53 |
| `morpheus-wrapper-linear-required` (re-run after red) | `claude-opus-5` | $1.67 | — |
| `morpheus-wrapper-holistic` | `claude-sonnet-5` | $1.05 | $0.68 |
| `morpheus-wrapper-blast-radius` | `claude-sonnet-5` | $0.46 | $0.25 |
| **total per PR** | | **$5.19** | **$2.46** |

Every number above should have been a field in the verdict files. Two things it immediately surfaced, neither visible from the gate today:

1. **A red verdict's re-run cost $1.67** — pure rework from a ticket/diff mismatch. Nothing in the artifacts attributes that cost to the retry.
2. **A configured `model:` that does not describe what runs.** `monorepo-nx4/.claude/agents/morpheus-reviewer.md` declares `model: sonnet`, but the cloud reviewer that loads that persona takes its model from a different config and actually runs `claude-opus-5` — a 2.5× price difference. Recording the *observed* model makes that class of drift self-evident; recording the configured one would have propagated the error.

## Suggested implementation

### 1. Extend `ReviewerEvidence` (`subagent-provenance.ts:33-55`)

It already carries `agentType`, `agentId`, `readDiff`, `readDoc`, `toolCallCount`, `offRepoSearches`, `transcriptPath` — all read in one pass. Add:

```ts
models: string[];        // distinct message.model values seen, in first-seen order
inputTokens: number;
outputTokens: number;
cacheCreationTokens: number;
cacheReadTokens: number;
```

**`models` is deliberately an array, not a string.** A single reviewer run can span more than one model — a fallback after a refusal, or a mid-run config change. Collapsing to one value forces a lossy choice at read time; an array records what happened and lets the renderer decide.

**Do not compute cost here.** Prices change, vary by platform, and differ under intro pricing — a hardcoded table in `rules-config` would rot silently and be wrong for Bedrock/Vertex callers. Emit tokens plus model and let the consumer price it, or make the rate table config.

### 2. Write it into the verdict file — as a separate key the reviewer does not own

The reviewer writes `review-<id>.json`. The provenance pass runs *after*. Rather than expanding the schema the reviewer fills in (which reintroduces self-report), have `wp-finish-upsert-pr` merge an observed block keyed distinctly:

```jsonc
{
  "id": "morpheus-wrapper-holistic",
  "status": "green",
  "output": "...",
  "override": "",
  "observed": {                       // written by webpieces, never by the reviewer
    "models": ["claude-sonnet-5"],
    "inputTokens": 192,
    "outputTokens": 15458,
    "cacheCreationTokens": 589754,
    "cacheReadTokens": 2985991,
    "toolCallCount": 12,
    "transcriptPath": "/Users/…/agent-a69d….jsonl"
  }
}
```

Reject an `observed` key supplied by the reviewer — same reasoning as `CK_BAD_FORMAT` for a hand-written `success`. If a reviewer writes one, that is a bug in its agent file, not data.

### 3. Roll up per PR on the dashboard

`pr-body.md` already renders a checklist table. A `models` column and a token/cost column turn the gate into its own cost telemetry, so a repo can see the per-PR total and the per-checklist split without touching Claude Code internals. This is what makes roster tuning possible: today, deciding whether a checklist earns its place is guesswork.

## Notes for whoever implements it

- **Transcript parsing is already flagged as best-effort** (`subagent-provenance.ts:145-150`: a format change must not wedge the gate). Hold that line — missing `model`/`usage` should yield empty/zero and a warning, never a blocked PR. This is quality telemetry, not an integrity gate.
- **`usage` appears per assistant message and must be summed**, not read from the last record. Cache-read tokens dominate — in the measurements above they were ~96% of all tokens — so a naive last-record read under-reports by a wide margin.
- **`<synthetic>` model records exist** in transcripts and carry zero usage; skip them rather than counting them as a distinct model, or `models` fills with noise.
- **Do not reuse the `id`↔`agentType` assumption** if a future config lets `id` diverge from `subagent`; key the merge on the same value `checklistResultPath` uses.
- Related, and already FIXED — "reviewer instructions lead with `ALL.diff`" shipped as PR #553 (`Lead the reviewer with the manifest and the full source, not with ALL.diff`), so its report is not in `backlog/`. Same transcript-reading surface: `readDiff`/`readDoc` there and `model`/`usage` here still come from one pass, so implement this inside that same loop.
