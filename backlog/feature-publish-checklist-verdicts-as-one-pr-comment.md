# FEATURE: publish checklist verdicts as ONE PR comment — the reviewer's verdict currently reaches nobody

> **REVISED 2026-07-29 after running this end-to-end on `monorepo-nx2` #740 against `0.4.475`.**
> The original filing proposed one comment **per** checklist. Having watched it run, the
> recommendation is now **one combined comment** with a section per checklist — see
> "Suggested design" below. The reasoning is recorded there rather than silently swapped.
>
> **There is nothing to check in.** `review.json` is gitignored and `wp-finish-upsert-pr` already reads
> it and turns it into the PR **title and body**. This asks for exactly the same mechanism applied to
> every `review-<id>.json`: read the local file, publish it as a comment. No artifact enters git
> history, and the earlier "commit review.json so CI can re-read it" idea — correctly rejected in #484
> — is not being revived.

**Package:** `@webpieces/pr-gate` (dashboard + finish-upsert-pr)
**Version seen:** `0.4.475` (originally filed against `0.4.470`; still absent)
**Severity:** High for the feature's purpose. `wp-finish-upsert-pr` already **reads** `review-<id>.json`,
**enforces** it, and **verifies** the subagent ran — then throws the reviewer's actual findings away. The
PR shows one word. A review process whose output never reaches a reviewer is a review process that
exists only as a gate.

**Source:**
- `packages/tooling/pr-gate/src/scripts/commands/finish-upsert-pr-command.ts:206-249` (`upsertPr` — body only)
- `packages/tooling/pr-gate/src/dashboard/dashboard.ts:19-37` (`ChecklistRow`), `:193-203` (`checklistStatusText`)
- `packages/tooling/rules-config/src/review-json.ts:305-315` (`resolveVerdict` — where `output` is captured and then dropped)

## The gap

The pipeline is complete right up to the last step:

```
review-<id>.json {success, output, override}
  → loadChecklistResults()            review-json.ts:292-301
  → resolveVerdict()                  review-json.ts:305-315   ← `output` captured here
  → ChecklistRow(title, severity, status, detail)
  → checklistStatusText()             dashboard.ts:193-203     ← `detail` DISCARDED unless OVERRIDDEN
  → one line in the PR body
```

`checklistStatusText` renders `detail` for exactly one of five verdicts:

```ts
if (row.status === CK_OVERRIDDEN) { ...` — override: ${row.detail.trim()}` }   // rendered
if (row.status === CK_FAIL)    return `🔴 ${sev} — FAILED review`;              // DROPPED
if (row.status === CK_MISSING) return `⚪ ${sev} — not reviewed`;
if (row.status === CK_ACKED)   return `🟢 ${sev} — acknowledged`;
return `🟢 ${sev} — passed`;                                                    // DROPPED
```

Two consequences:

1. **A passing review is invisible.** `.webpieces/` is gitignored in consuming repos, so `review-<id>.json`
   never leaves the checkout. The only artifact reaching GitHub says `🟢 BLOCK — passed`.
2. **A failing WARN review says nothing about why.** `🔴 WARN — FAILED review`, full stop. This one is
   arguably a straight bug: `ChecklistRow.detail`'s own doc comment at `dashboard.ts:29` states it is
   *"surfaced for OVERRIDDEN + **WARN-FAIL**"*. The code does not do the WARN-FAIL half.
   (BLOCK-FAIL never renders — it throws before the dashboard is built — so WARN is the only path where
   a failing verdict reaches a human, and it is the path that drops the reason.)

## Measurement

Consuming repo: **`/Users/deanhiller/workspace/onetablet/monorepo-nx2`**,
[PR #740](https://github.com/mealco-internal/monorepo-nx/pull/740).

The `envvars` BLOCK checklist triggered on 12 changed Dockerfiles. A `morpheus-reviewer` subagent ran
**twice** (independently verified from the harness both times) and produced a substantial review — it
established that a single clean-context container build generalises to all 12 services, verified
`.npmrc` cannot reach any final image, interrogated whether a committed HMAC salt belongs in Secret
Manager, traced the `permissions:` block against `check-pr-command.ts` source, and **caught two real
defects** the author had introduced (a `**/Dockerfile` vs `**/Dockerfile*` glob mismatch, and a
`json.dumps(ensure_ascii=True)` regression that rewrote unrelated lines).

Every word of that is on one laptop. The entire trace on the PR:

```
**Checklist — Env / deploy config:** 🟢 BLOCK — passed
```

The repo owner's reaction on seeing it — *"if this PR enabled morpheus and all of those gates, why do I
see no morpheus here?"* — is the bug report.

## Suggested design

### 1. ONE combined comment, with a section per checklist

New renderer beside `Dashboard`, e.g. `packages/tooling/pr-gate/src/dashboard/checklist-comment.ts`,
emitting a single comment:

```markdown
<!-- webpieces-checklists v1 -->
## 🔍 Company review checklists — 🔴 1 of 3 failed

### 🔴 morpheus-migrations — FAILED
_`morpheus-migrations` · independent run verified from harness_

<output verbatim>

### 🟢 morpheus-envvars — passed
_`morpheus-envvars` · independent run verified from harness_

<output verbatim>

### 🟢 morpheus-graphql — passed
…
```

Lead with a roll-up status line and **order failures first**, so the one that matters is at the top.

Post from `upsertPr` **after** `prRef` resolves (`finish-upsert-pr-command.ts:238`) — the PR number does
not exist before that. Per section include the `subagent` name and the provenance status (`ok` /
`skipped`): `PROVENANCE_SKIPPED` is returned whenever `CLAUDE_CODE_SESSION_ID` is unset, and a reader
trusting the comment needs to tell a harness-verified independent run from an unverified one.

**Why combined, having now run it.** The original filing said one comment per checklist. Four reasons
to prefer one:

- A single repo can define **six** checklists (monorepo-nx2 does). Six comments per PR, each re-edited
  on every push, buries the human conversation. One comment keeps a single canonical place to look.
- These are GitHub **issue** comments, which are not resolvable or threadable like review comments —
  so the main argument for splitting (independent resolution) does not actually exist.
- One marker, one find-then-PATCH, one failure mode. Per-checklist means N API calls per push and N
  chances to orphan a comment when a checklist is renamed or dropped from the manifest — and under the
  `{ doc }` manifest a checklist's `id` **is** its subagent name, so renaming the reviewer renames the
  id and orphans its comment.
- The overall verdict is visible at the top instead of requiring a reader to scan six comments to find
  the one that failed.

The one real argument the other way is that a failing checklist stands out more as its own comment.
The roll-up line plus failure-first ordering covers that.

### 2. Idempotency is mandatory, not a nice-to-have

`wp-finish-upsert-pr` runs on **every push**. Naively appending would leave a new comment per push.
Find-then-PATCH on the hidden marker:

```
GET   repos/{owner}/{repo}/issues/{n}/comments
      → find the comment whose body contains `webpieces-checklists v1`
PATCH repos/{owner}/{repo}/issues/comments/{commentId}     (exists → update)
POST  repos/{owner}/{repo}/issues/{n}/comments             (absent → create)
```

`gh pr comment --edit-last` is **not** selective enough — it targets the last comment by the author
regardless of what it is, so it would clobber an unrelated comment the tool itself posted.

With a single combined comment the marker no longer needs an `id`, which also removes the orphaning
problem above entirely.

### 3. `ChecklistRow` still needs its id (for the section headings, not the marker)

`finish-upsert-pr-command.ts:163-168` builds rows as
`new ChecklistRow(req.title, req.severity, verdict.status, verdict.detail)` — **title only**. Under the
combined-comment design the marker no longer needs an id, but each SECTION still does: the heading
should name the reviewer (`morpheus-envvars`), which under the `{ doc }` manifest IS the id. Add `id`
to `ChecklistRow`; it also lets the dashboard line and the comment refer to the same thing.

### 4. Fix `detail` on CK_FAIL, and correct the doc comment

Make `dashboard.ts:193-203` match `dashboard.ts:29`. At minimum surface `detail` for `CK_FAIL`. For
`CK_PASS`, keeping the body line terse is defensible **once comments carry the depth** — but then the
line-29 comment should say so rather than claiming WARN-FAIL is rendered.

## Notes for whoever implements it

- **Do not put the full output in the PR body.** The body is already a dashboard plus the HMAC gate
  marker, and multi-thousand-word reviews would bury it. Body = at-a-glance status; comments = depth.
- **`.webpieces/` is gitignored in consumers, and should stay that way.** The repo owner was explicit:
  review files must NOT be checked in. Comments are the right transport precisely because they need no
  artifact in git history — which is also what the earlier
  [`bug-pr-gate-checklists-have-no-ci-side-enforcement`](./bug-pr-gate-checklists-have-no-ci-side-enforcement.md)
  report got wrong and #484 correctly rejected.
- **Comment size limits — sharper with one combined comment.** GitHub caps a comment at 65536
  characters, and now SIX verbose reviewers share that budget rather than each getting their own. Do not
  truncate the whole body blindly: truncate the longest sections first so a short FAILED verdict is
  never cut to make room for a long passing one, and mark each truncation inline. Never fail the whole
  `wp-finish-upsert-pr` run at the very last step, after the push has already landed.
- **Failure of the comment post must not fail the gate.** By the time comments are posted the branch is
  pushed and the PR is created/updated; throwing there leaves the user in a confusing half-done state.
  Warn to stderr and continue.
- **Consider `disabled`/opt-out.** A repo with WARN-only checklists may not want comment noise on every
  push. A `prGate.checklistComments: true|false` switch, defaulting on, costs little.
- **Regression tests:** (a) three triggered checklists produce ONE comment with three sections;
  (b) a second run EDITS that comment rather than adding another; (c) a mixed pass/fail set puts the
  failure first and the roll-up line reads `🔴 1 of 3 failed`; (d) a `CK_FAIL` WARN row renders its
  `detail` in both the comment and the body; (e) combined output >65536 chars truncates the longest
  section first, keeps every verdict line, and the run still succeeds; (f) a renamed reviewer does not
  orphan the previous comment.
