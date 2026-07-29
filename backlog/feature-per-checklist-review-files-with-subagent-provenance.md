# FEATURE: per-checklist `review-<id>.json` with subagent provenance — stop one shared file being clobbered, and stop the author grading its own homework

**Package:** `@webpieces/rules-config` (schema + loader), `@webpieces/pr-gate` (enforcement, dashboard)
**Version seen:** `0.4.463`
**Severity:** Medium-High — not a wrong result. Three structural gaps in the acknowledgement contract:
concurrent reviewers clobber one shared file, the *verdict* is never recorded (only a boolean), and
nothing distinguishes an independent review pass from the same agent that wrote the code asserting
its own work is fine.

**Source:**
- `packages/tooling/rules-config/src/review-json.ts:11-21` (`ChecklistAck`), `:155-213` (`loadReviewJson`), `:219-250` (parse + enforce)
- `packages/tooling/pr-gate/src/scripts/commands/finish-upsert-pr-command.ts:81-86`
- `packages/tooling/pr-gate/src/dashboard/dashboard.ts:21-31, 249-252`

Companion to [`bug-pr-gate-checklists-have-no-ci-side-enforcement`](./bug-pr-gate-checklists-have-no-ci-side-enforcement.md).
That one is about *where* enforcement runs; this one is about *what* is being enforced.

## The gaps

Today the entire acknowledgement contract is one interface:

```ts
// review-json.ts:11-21
export class ChecklistAck {
    id: string;
    acknowledged: boolean;
    notes: string[];
}
```

enforced by:

```ts
// review-json.ts:235-250
private requiredChecklistErrors(required, acks): string[] {
    for (const req of required) {
        if (req.severity !== CHECKLIST_BLOCK) continue;
        const ack = acks.find((a) => a.id === req.id);
        if (!ack || !ack.acknowledged) { errors.push(...); }
    }
}
```

**Gap 1 — one file, N writers.** Every ack lands in a single `.webpieces/pr-review/<branch>/review.json`.
A diff touching a migration *and* a Dockerfile *and* a `.gql` file triggers three checklists. If a
consumer runs three reviewers concurrently — the natural thing to do, since they are independent —
they race on one file and the last writer wins. Nothing in the schema or the loader prevents it, and
a lost ack fails closed (the PR refuses to open) so it presents as a confusing false negative.

**Gap 2 — the verdict is not recorded.** `acknowledged: true` means "I walked it," not "it passed."
A reviewer that walks `morpheus-migrations.md`, finds a `NOT NULL` added with no backfill, and writes
`acknowledged: true` is *schema-valid*. `notes[]` is free-form and, per `loadReviewJson`, is not
validated at all — `asStringArray` (`:253-257`) silently drops non-strings and defaults to `[]`.
There is no field that means "this checklist FAILED," so the gate cannot distinguish "reviewed, fine"
from "reviewed, found a problem, shipping anyway."

**Gap 3 — no provenance.** `acknowledged: true` is written by whichever agent happens to be holding
the file. The design doc is explicit that this is by design:

> identity/authorization (`acknowledged: true` is written by the AI — surfacing/audit only,
> "do not let this grow a `signOff` field")

That is right about *authorization*. But it leaves no way to express the one property a consumer
actually wants: **that a separate reviewer looked, rather than the author self-certifying.** In
practice the agent that just wrote the diff is the one writing the ack, which is the exact
conflict-of-interest a review gate exists to remove.

## Measurement

Consuming repo: **`/Users/deanhiller/workspace/onetablet/monorepo-nx2`**.

That repo's review process is a set of path-scoped checklists in `.claude/review/morpheus-*.md`,
intended to be executed by a dedicated reviewer persona (`.claude/agents/morpheus-reviewer.md`, 213
lines) that is separate from the coding agent. Under today's contract there is no way to express or
verify that separation — the coding agent reads the doc, decides it is satisfied, and writes
`acknowledged: true`.

**Empirical finding: the Claude Code harness already records exactly the missing provenance.** Verified
by spawning a subagent and having it introspect its own runtime:

- The subagent's system prompt never names its own type. There is no `CLAUDE_AGENT_ID` env var.
  `CLAUDE_CODE_CHILD_SESSION=1` is set but is identical for every subagent in the session. There is
  no separate OS process — `ps` shows the main CLI as the parent, so process identity proves nothing.
- **But the harness writes, next to each subagent transcript:**

```
~/.claude/projects/<cwd-slug>/$CLAUDE_CODE_SESSION_ID/subagents/agent-<agentId>.meta.json
{"agentType":"Explore","description":"Introspect subagent identity",
 "toolUseId":"toolu_015GpmL41KTa3H3sZTHhkNoM","spawnDepth":1}
```

- and `agent-<agentId>.jsonl` record 0 carries:

```
agentId, isSidechain: true, gitBranch: 'dean/watch-cd-734',
sessionId, cwd, version, timestamp
```

`agentType` and `spawnDepth` are written by Claude Code, **not by the model**. `$CLAUDE_CODE_SESSION_ID`
is present in the environment of any process Claude Code spawns — including `pnpm wp-finish-upsert-pr`
— so the path is deterministically derivable from inside the gate.

The corollary matters for the design: **a self-reported `writtenByAgentId` field would be worthless.**
The subagent cannot obtain its own id (the introspection above recovered it only because plan-mode
happens to name its scratch file `<slug>-agent-<agentId>.md` — a leak, not an API), and the main
agent could write any value it likes. Provenance has to be *read from harness artifacts*, never
*asserted in the payload*.

## Suggested design

### 1. Per-checklist files

`.webpieces/pr-review/<branch>/review-<checklistId>.json`, one per triggered checklist:

```jsonc
{
  "success": false,
  "output": "Migration drops NOT NULL on \"Order\".\"brandId\" with no backfill (step 4 of the checklist).\nCREATE INDEX is not CONCURRENTLY — locks writes for the duration.",
  "override": "deploying behind a flag; backfill tracked in ONE-2210"   // optional
}
```

`review.json` keeps `title`/`riskScore`/`riskLevel`/`summary`/`violations`/`risks`/`filesToReview`
exactly as today. Only `checklists[]` moves out. Writers no longer contend.

Enforcement replaces `requiredChecklistErrors`:

| state | result |
|---|---|
| file missing, severity BLOCK | refuse — same as an unacknowledged ack today |
| `success: true` | pass |
| `success: false`, no `override` | refuse, printing `output` verbatim |
| `success: false` + non-empty `override` | pass; dashboard renders 🟡 **overridden** with the justification |

`override` is deliberately a free-text justification, not a boolean — it forces the bypass to be
stated and puts it in the PR body, where a human sees it.

### 2. `checklists[].subagent` + harness-verified provenance

New optional field on `ChecklistDefinition`:

```ts
// checklist-config.ts
subagent?: string;   // expected agentType, e.g. "morpheus-reviewer"
```

When set, `wp-finish-upsert-pr` (and `wp-check-pr`, per the companion report) additionally requires
evidence that such a subagent actually ran on this branch:

```ts
const sessionId = process.env['CLAUDE_CODE_SESSION_ID'];
const dir = path.join(os.homedir(), '.claude', 'projects', cwdSlug, sessionId, 'subagents');
// for each *.meta.json: agentType === def.subagent && spawnDepth >= 1
// cross-check the sibling agent-<id>.jsonl record 0:
//   isSidechain === true && gitBranch === <current branch> && timestamp > <branch-point time>
```

Absent `CLAUDE_CODE_SESSION_ID` (a plain terminal, CI), the check **skips with a printed warning**
rather than failing — otherwise the feature would break every non-Claude-Code consumer.

### 3. Back-compat

`checklists[]` in `review.json` stays supported and is checked first, so existing consumers do not
break. Prefer `review-<id>.json` when present. Deprecate the inline array in a later release.

## Notes for whoever implements it

- **State the limit in the docs, do not oversell it.** A determined agent can `cat > agent-fake.meta.json`
  with any `agentType`. This design raises the bar from *"trust the model's word"* to *"deliberate,
  auditable forgery outside the repo"* — it does **not** make review provenance cryptographically
  sound. Real proof needs the harness to stamp or sign the result envelope outside model control,
  which does not exist today. Anyone reading `subagent:` and assuming it is tamper-proof will be
  wrong, so say so in the field's doc comment.
- **`slug` is not the agent type.** Record 0 of the transcript has a `slug` field, but it is the
  *session* slug (e.g. `i-lost-track-but-zany-flame`), identical across every subagent in the
  session. Only `.meta.json` carries `agentType`. Reading `slug` will silently match everything.
- **`spawnDepth` is the subagent discriminator**, together with `isSidechain: true`. Both are
  harness-written. Neither is available to the subagent itself.
- **Do not add a `writtenByAgentId` payload field.** See the measurement section — it is unobtainable
  by the writer and forgeable by everyone else, so it would encode false confidence.
- **`parseChecklistAcks` is deliberately tolerant** (`review-json.ts:219-231`) — unknown ids ignored,
  `acknowledged` a strict `=== true`. Keep that posture for the new files: an unknown
  `review-<id>.json` should be ignored, not an error, so a stale file from a removed checklist does
  not wedge a branch.
- **Fix the `parseReviewJson` catch path while you are here** (`:270`): on a JSON syntax error it calls
  `this.reviewJsonSchemaHint(filePath)` *without* `required`, so the AI gets the bare schema and none
  of the checklist instructions — exactly when it most needs them.
- **Regression tests:** (a) two checklists triggered, two files written concurrently, both acks
  survive — this fails today with one shared file; (b) `success:false` with no `override` refuses and
  prints `output`; (c) `success:false` with `override` passes and the justification reaches the
  dashboard; (d) `subagent` set but no matching `.meta.json` refuses; (e) `subagent` set and
  `CLAUDE_CODE_SESSION_ID` unset warns and passes.
