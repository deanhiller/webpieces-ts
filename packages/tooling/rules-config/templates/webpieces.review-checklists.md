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
pnpm wp-checklist
```

It validates the checklist config against **your** diff and prints which reviewer subagents you owe, and
exactly what to tell each — its doc, what put it in scope, the `git diff` command with the real base sha,
and the `review-<id>.json` it must write. That block is **self-sufficient**: hand a reviewer those lines
verbatim. It is safe to run any number of times and never blocks.

Checklists already reviewed on this branch are **not** re-listed — verdict files persist, so a second
wp-start/wp-finish cycle re-instructs nothing.

`wp-finish-upsert-pr` recomputes the same set and **refuses to open the PR** while any reviewer still owes
a passing verdict, naming only the ones still missing.

Note that **not every checklist is pattern-matched**: one with no `patterns` runs on EVERY PR, and the
whole diff is in its scope. `wp-checklist` says `ALWAYS RUNS` for those rather than calling the whole diff
a "match".

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
