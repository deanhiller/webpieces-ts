# FEATURE: post one PR comment per triggered checklist — the reviewer's verdict currently reaches nobody

**Package:** `@webpieces/pr-gate` (dashboard + finish-upsert-pr)
**Version seen:** `0.4.470`
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

### 1. One comment per triggered checklist

New renderer beside `Dashboard`, e.g. `packages/tooling/pr-gate/src/dashboard/checklist-comment.ts`:

```markdown
<!-- webpieces-checklist v1 id=envvars -->
## 🔍 Env / deploy config — PASSED
_reviewed by `morpheus-envvars` · independent subagent run verified from the harness_

<output verbatim>
```

Post from `upsertPr` **after** `prRef` resolves (`finish-upsert-pr-command.ts:238`) — the PR number does
not exist before that. Include the `subagent` name and the provenance status (`ok` / `skipped`) so a
reader can distinguish a verified independent run from an unverified one; `PROVENANCE_SKIPPED` is
returned whenever `CLAUDE_CODE_SESSION_ID` is unset, and that distinction matters to whoever is
trusting the comment.

### 2. Idempotency is mandatory, not a nice-to-have

`wp-finish-upsert-pr` runs on **every push**. Naively appending would leave N comments per checklist per
push. Find-then-PATCH on the hidden marker:

```
GET   repos/{owner}/{repo}/issues/{n}/comments
      → find the comment whose body contains `webpieces-checklist v1 id=<id>`
PATCH repos/{owner}/{repo}/issues/comments/{commentId}     (exists → update)
POST  repos/{owner}/{repo}/issues/{n}/comments             (absent → create)
```

`gh pr comment --edit-last` is **not** selective enough — it targets the last comment by the author
regardless of which checklist it belongs to, so with two triggered checklists it would clobber.

### 3. Blocker: `ChecklistRow` has no id

`finish-upsert-pr-command.ts:163-168` builds rows as
`new ChecklistRow(req.title, req.severity, verdict.status, verdict.detail)` — **title only**. The marker
must key on the stable `id`, not a title someone may reword. Add `id` to `ChecklistRow` first; it also
lets the dashboard line and the comment refer to the same thing.

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
- **Comment size limits.** GitHub caps a comment at 65536 characters. A verbose reviewer will exceed it.
  Truncate with a clear marker rather than failing the whole `wp-finish-upsert-pr` run at the very last
  step, after the push has already landed.
- **Failure of the comment post must not fail the gate.** By the time comments are posted the branch is
  pushed and the PR is created/updated; throwing there leaves the user in a confusing half-done state.
  Warn to stderr and continue.
- **Consider `disabled`/opt-out.** A repo with WARN-only checklists may not want comment noise on every
  push. A `prGate.checklistComments: true|false` switch, defaulting on, costs little.
- **Regression tests:** (a) two triggered checklists produce two distinct comments; (b) a second run
  EDITS both rather than creating four; (c) a reworded `title` still updates the same comment (proves the
  marker keys on `id`); (d) a `CK_FAIL` WARN row renders its `detail` in both the comment and the body;
  (e) a >65536-char output is truncated and the run still succeeds.
