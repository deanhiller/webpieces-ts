# Webpieces review checklists — how to satisfy them

Your repo defines company review checklists in `pr-gate.checklists` in `webpieces.config.json` — an
array of `{ subagent, doc?, patterns? }`, and that is the **only** accepted shape. Each names a reviewer
**subagent** (a `.claude/agents/<subagent>.md`, which webpieces verifies exists) and, optionally, a
**repo-relative** detail doc and path `patterns`:

```jsonc
"commands": { "pr-gate": { "checklists": [
  { "subagent": "db-migration-reviewer",
    "doc": ".claude/review/db-migrations.md",
    "patterns": ["**/migrations/**", "**/*.sql"] }
] } }
```

> **The old `checklists: { "doc": "..." }` shape is REMOVED.** It hid this array in a
> `<!-- webpieces:checklists [...] -->` HTML comment inside a markdown doc, where no schema, editor, or `jq`
> could reach it. If your config still has it, **config validation fails** and prints the exact edit: move
> the array into `webpieces.config.json` and make each entry's `doc` repo-relative (they used to resolve
> relative to the index doc). There is no compatibility mode — fix the config and move on.

## The one command you run

```bash
pnpm wp-review-upsert-pr
```

It validates and commits any in-progress 3-point merge, runs the build gate, then **extracts this branch's
diff to disk** and writes one instructions file per reviewer under
`.webpieces/pr-review/<branch>/instructions/`. It prints a copy-paste spawn block per reviewer whose prompt
is a POINTER to that file and nothing else.

That indirection is the design. Everything volatile — the diff, the matched files, the verdict schema, the
resolved context paths — is REGENERATED every run, so it cannot go stale. The registered
`.claude/agents/<subagent>.md` stays a thin stub that says "read the instructions file your caller names".
When the verdict format last changed, hand-written agent files kept documenting the removed `success`
field and a real PR had to carry a correction in its spawn prompt to work around it; nothing restated by
hand can drift out of date if nothing is restated by hand.

Unlike the report-only command it replaces, this one **can fail** — on an unresolved merge or a red build.
It fails before any reviewer is spawned, which is the point.

Checklists already reviewed on this branch are **not** re-listed — verdict files persist, so a second
start/review/finish cycle re-instructs nothing.

`wp-finish-upsert-pr` recomputes the same set and **refuses to open the PR** while any reviewer still owes
a passing verdict, naming only the ones still missing.

Note that **not every checklist is pattern-matched**: one with no `patterns` runs on EVERY PR, and the
whole diff is in its scope. `wp-review-upsert-pr` says `ALWAYS RUNS` for those rather than calling the
whole diff a "match" — and says so loudly, because a patternless checklist fires on docs-only PRs too, and
that is usually a missing `patterns` rather than an intent.

Where patterns DO apply, matching is deliberately **coarse** — the reviewer subagent makes the fine,
content-level judgment by reading the actual diff.

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
   `"status": "green"` when the diffs add no new route/queue.)
3. Have it **write its verdict** to `.webpieces/pr-review/<branch>/review-<id>.json` (one file per
   checklist, so concurrent reviewers never clobber each other). `<id>` is the subagent name.

**You may never write a reviewer's `review-<id>.json` yourself.** If a named subagent cannot be spawned,
that is a config bug, not your cue to self-certify — say so and stop. (webpieces now rejects a checklist
whose `subagent` has no `.claude/agents/<subagent>.md`, so this should surface as a config error instead.)

## `review-<id>.json` (each reviewer subagent writes its own)

```json
{
  "id": "<the checklist id / subagent name>",
  "status": "green | yellow | red",
  "output": "what you checked and what you found",
  "override": ""
}
```

| `status` | outcome |
| --- | --- |
| `green` | 🟢 passes, nothing to flag |
| `yellow` | 🟡 **passes with concerns.** Blocks nothing; your `output` is published on the PR for a human to read |
| `red` + empty `override` | 🔴 **`wp-finish` refuses to open the PR** and prints your `output` verbatim |
| `red` + non-empty `override` | 🟠 ships anyway; the `override` justification is published on the PR |

> **The `success` boolean is REMOVED — there is no compatibility mode.** A verdict file still using it is
> rejected with a message naming the replacement. It was removed because a boolean gave a reviewer no way
> to say *"this is fine, but someone should look at X"*: the only route to raising a concern was to fail the
> PR and then override your own failure, which reads on the dashboard as a deliberately-accepted defect.

**Prefer `yellow` over `red`-plus-`override`** when a change is acceptable but worth attention. Reserve
`red` + `override` for deliberately, visibly accepting a known issue.

## What lands on the PR

`wp-finish-upsert-pr` posts ONE comment per PR (updated in place on every push) listing **every** defined
checklist as a checkbox — the ones whose reviewers ran *and* the ones that were skipped — each with a
sub-bullet naming the globs that matched, the files they matched, or how many changed files they missed.
**A skipped checklist is a normal, healthy outcome** and is shown as such; it is published so a reader can
tell "evaluated and not applicable" from "never wired up", and so nobody has to guess why a given reviewer
was involved. Below the roster, each reviewer that ran gets its full `output` verbatim.

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

## `provenance.json` (the tooling writes this; you never do)

`wp-finish-upsert-pr` writes `.webpieces/pr-review/<branch>/provenance.json` — the audit record of **how
the review was done**, as opposed to what it concluded. Per reviewer it links the verdict to the
transcript of the subagent that produced it, plus what that reviewer was *offered* (its instructions file,
the diff dir, its checklist doc) against what it demonstrably *read*, and its tool-call counts.

**Open this when auditing the review process itself** — e.g. "did the reviewer that passed this checklist
actually open the diff, or did it write a verdict having read nothing?" It is written on every finish,
including one that REFUSES for a missing reviewer, and copied to `old-provenance.json` beside
`old-review.json` when a review is consumed.

Never author or edit it. A reviewer subagent physically cannot know its own transcript path — the
environment exposes the *parent* session id and no agent id — so any AI-written link would be invented.
Every path in the file is derived by the tooling from Claude Code's own artifacts.

> The linked transcripts are a **wasting asset**: Claude Code deletes them after `cleanupPeriodDays`
> (default 30). `transcriptsExpireOn` records when the first link goes dead. The counters recorded
> alongside (`readDiff`, `readDoc`, `toolCallCount`, `offRepoSearches`) stay accurate forever, so an
> expired transcript costs you the raw conversation, not the finding.
