> # ✅ RESOLVED — fixed **2026-08-17** on branch `dean/reviewer-credit-by-read-evidence`. Kept as a forensic record only.
>
> **What shipped, against the "Suggested fix" below:** the read-evidence channel, plus a stronger one the
> report did not propose — the reviewer's own VERDICT PATH. `ReviewerContext.verdictPaths` gives
> `.webpieces/pr-review/<slug>/review-<id>.json`, which is worktree-absolute, per-branch AND per-checklist,
> so it proves more than `diffDir` (which proves only the branch). Either channel credits;
> `isSidechain`/`spawnDepth`/the one-run-one-checklist exclusion are untouched, and the `branchOfCwd` gate
> was NOT loosened, as the report insisted.
>
> **Deviation worth knowing:** credit does not require `readDiff && readDoc`. A checklist doc is not
> branch-specific, so requiring it adds no attribution strength — only a new unrecoverable refusal for a
> reviewer handed its doc another way, which is the same defect class this bug is. `readDoc` is still
> recorded; `wroteVerdict` was added beside it in `provenance.json`.
>
> Both "Notes for whoever fixes it" items landed: stage ③ now splits "never ran" (spawn one) from "ran but
> unattributable" (do NOT re-spawn, here is the cwd remedy), and the count is the union of checklists at
> fault rather than the paragraph count that printed `1 checklist(s)` above seven names. Regression tests
> (a) and (b) are asserted separately, as asked.

# BUG: a reviewer spawned from the primary clone can never be credited for a worktree branch — `sidechainOnBranch`'s cwd fallback is gated off exactly where it is needed

**Package:** `@webpieces/rules-config` (enforced by `@webpieces/pr-gate`)
**Version seen:** `0.4.644`
**Severity:** High — an unrecoverable deadlock. Seven reviewers genuinely ran, wrote seven verdicts,
and `wp-review-upsert-pr` confirms all seven **STAND**; `wp-finish-upsert-pr` reports all seven as
never having run. There is no in-flow recovery, and the two stages give **directly contradictory
instructions**, one of which destroys the other's evidence.

**Source:**
- `packages/tooling/rules-config/src/subagent-provenance.ts:396` — `sidechainOnBranch`
- `packages/tooling/rules-config/src/subagent-provenance.ts:407-409` — the `gitBranch` compare and the cwd fallback
- `packages/tooling/rules-config/src/subagent-provenance.ts:369-385` — the doc block explaining why the fallback is gated on `isLinkedWorktree`
- `packages/tooling/rules-config/src/subagent-provenance.ts:316` — `findMatchingAgentId`
- `packages/tooling/pr-gate/src/scripts/workflow/provenance-enforcer.ts` — the refusal path

## The bug

`sidechainOnBranch` credits a reviewer when record 0's `gitBranch` matches the PR branch, and
otherwise falls back to asking git what branch record 0's own `cwd` is pinned to:

```ts
const want = this.stripWp(branch);
if (this.stripWp(gitBranch) === want) return true;
return want !== '' && this.stripWp(this.branchOfCwd(rec['cwd'])) === want;   // :409
```

`branchOfCwd` resolves only for a **linked worktree**; a primary clone deliberately yields `''`
(`:369-385`), on sound reasoning — the primary clone gets re-checked-out constantly, so crediting a
reviewer by "what is checked out at finish time" would credit stale reviewers by construction.

**But the harness stamps record 0 from the SPAWNING session's cwd, not from the files the reviewer
was told to read.** The Agent/Task tool has no cwd parameter. A subagent inherits its parent's cwd.
So when a session rooted in the **primary clone** spawns a reviewer to review a **worktree** branch:

- `gitBranch` = the primary clone's current branch (`main`) → mismatch
- `cwd` = the primary clone → fallback gated off → `''`
- → reviewer not credited, `provenance.json` records `reviewers: []`

The reviewer *did* read the worktree's materialized diff, *did* read its checklist doc, and *did*
write its verdict into the worktree. Every artifact is correct. Only the harness-stamped cwd points
at the clone, because that is the only cwd a subagent can have.

**There is no way to satisfy this from a primary-clone session.** Not by re-spawning — every respawn
is stamped identically. `isolation: 'worktree'` does not help: it creates a *new* worktree, not the
one under review. The only escape is for the human to start a fresh Claude Code session whose cwd is
the worktree, which is not something the flow tells them to do, or discoverable from the output.

## Why this is reachable on the normal path, not an exotic setup

The documented monorepo-nx flow is: create a sibling worktree per ticket, work there, drive the PR
gate from your session. If the *orchestrating agent* owns the worktree, its subagents inherit the
worktree cwd and everything works — which is why this has not bitten before.

It bites the moment the **human's main session** has to take over the PR flow, and that is not rare:

1. the worker agent hits the harness's 10-minute stall watchdog (observed **six times** in the
   session measured below) and dies mid-flow;
2. the reviewers it spawned are at `spawnDepth: 2`, and a further nested spawn hits
   `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` (observed: an agent reported "already at maximum subagent
   nesting depth (3 of 3), so I cannot spawn the required reviewer");
3. so the top-level session re-spawns the reviewers itself — correctly, at `spawnDepth: 1`, one per
   checklist, no self-certification;
4. and every one of them is stamped with the primary clone's cwd, so none is credited.

Step 3 is exactly what `AGENTS.md` rule 7 and the gate's own output instruct. Following the
instructions correctly produces the deadlock.

## Secondary bug — stage ② and stage ③ contradict each other, and obeying ③ destroys ②'s evidence

With the seven verdict files on disk, the two stages say opposite things on the same branch, minutes
apart:

`pnpm wp-review-upsert-pr`:

```
  ✓ morpheus-wrapper-linear-required — already reviewed on this branch; verdict STANDS, do NOT re-spawn
  … (all seven)
✅ Every checklist that applies is already reviewed — nothing to spawn.
   Reviews here are ONCE PER BRANCH … Do NOT re-spawn a reviewer listed above to "re-check" the newer
   code — it burns a full subagent run AND overwrites the verdict file it already wrote.
```

`pnpm wp-finish-upsert-pr`:

```
1 checklist(s) require an independent reviewer subagent that did not run — fix, then re-run:
  • these reviewer subagents did not run on this branch (spawn each as its OWN subagent — do not
    self-certify): morpheus-wrapper-linear-required, morpheus-wrapper-new-api-and-queues,
    morpheus-wrapper-holistic, morpheus-wrapper-blast-radius, morpheus-wrapper-security,
    morpheus-wrapper-business-logic, morpheus-wrapper-prod-reality
```

Stage ② keys on the **verdict files**; stage ③ keys on **transcript provenance**. They disagree
because those are different questions, but the output presents both as authoritative. An agent
obeying ③ overwrites seven verdicts that ② just certified — and the replacements are stamped with the
same cwd, so ③ refuses again. That is a loop that **destroys evidence on every iteration**.

Note the count is also wrong: `1 checklist(s) require …` followed by seven names.

This is the same family as
`bug-a-refused-reviewer-reads-as-one-that-never-ran-because-an-earlier-assert-masks-the-fail-message.md`
— a state that is not "never ran" being reported as "never ran", with an imperative that makes an
agent loop. Here the state is "ran, but unattributable".

## Measurement

Consuming repo: **`/Users/deanhiller/workspace/onetablet/monorepo-nx2`** (primary clone, on `main`)
Worktree under review: **`/Users/deanhiller/workspace/onetablet/monorepo-nx2-one-2546`**
Branch: `feature/ONE-2546-context-keys-trusted`, head `0fcd200f`
Date: 2026-08-17. Ticket ONE-2546.

The worktree is a genuine linked worktree:

```
git-dir: …/monorepo-nx2/.git/worktrees/monorepo-nx2-one-2546
common:  …/monorepo-nx2/.git
branch:  feature/ONE-2546-context-keys-trusted
```

All seven reviewer record-0s, read directly from the harness's own artifacts:

| checklist | isSidechain | gitBranch | cwd | agentType (meta) | spawnDepth |
|---|---|---|---|---|---|
| linear-required | `true` | `main` | `…/monorepo-nx2` | `morpheus-wrapper-linear-required` | 1 |
| security | `true` | `main` | `…/monorepo-nx2` | `morpheus-wrapper-security` | 1 |
| holistic | `true` | `main` | `…/monorepo-nx2` | `morpheus-wrapper-holistic` | 1 |
| blast-radius | `true` | `main` | `…/monorepo-nx2` | `morpheus-wrapper-blast-radius` | 1 |
| business-logic | `true` | `main` | `…/monorepo-nx2` | `morpheus-wrapper-business-logic` | 1 |
| new-api-and-queues | `true` | `main` | `…/monorepo-nx2` | `morpheus-wrapper-new-api-and-queues` | 1 |
| prod-reality | `true` | `main` | `…/monorepo-nx2` | `morpheus-wrapper-prod-reality` | 1 |

Every field the enforcer wants is correct **except** the two it cannot be: `gitBranch` and `cwd`.
`isSidechain` is `true`, `agentType` matches, `spawnDepth` is 1 (top-level, not self-certified).

Resulting `provenance.json`:

```json
{
  "sessionId": "541dd709-1f17-40ca-b10b-eac7aad428ba",
  "featureSlug": "feature-ONE-2546-context-keys-trusted",
  "headSha": "0fcd200f08f5df7ed57f0fd75e348b03478a6f53",
  "provenanceStatus": "missing",
  "reviewers": []
}
```

Seven verdicts existed on disk at that moment, none stale, all for this branch — `linear-required`
green, four advisory yellows, two green. `gh pr list --head feature/ONE-2546-context-keys-trusted` → `[]`.

### Note on `spawnDepth`, and one thing to double-check

`findMatchingAgentId` (`:322`) matches on `meta['agentType']`. In this harness build `agentType` and
`spawnDepth` live **only** in the `.meta.json` sidecar — they are **absent from record 0**, whose
top-level keys are exactly:

```
agentId, cwd, entrypoint, gitBranch, isSidechain, message, parentUuid,
promptId, sessionId, timestamp, type, userType, uuid, version
```

The doc block at `:123-125` describes this correctly. Flagging it only because a fix that starts
reading `agentType` from record 0 will find nothing.

## Evidence — transcripts and logs

All under `~/.claude/projects/-Users-deanhiller-workspace-onetablet-monorepo-nx2/`.

**Main session transcript** (3.2 MB; contains all 22 `Agent` spawns):
`541dd709-1f17-40ca-b10b-eac7aad428ba.jsonl`

**Reviewer subagent transcripts** — `541dd709-1f17-40ca-b10b-eac7aad428ba/subagents/`, each with a
sibling `.meta.json`:

| checklist | transcript |
|---|---|
| linear-required | `agent-a64f99a93105743ef.jsonl` |
| security | `agent-ab759f420e19a9002.jsonl` |
| holistic | `agent-a1c089c16c3e2ab8f.jsonl` |
| blast-radius | `agent-a789969dfea843d84.jsonl` |
| business-logic | `agent-a7948122a226f8f8e.jsonl` |
| new-api-and-queues | `agent-a4ad5be028df3b4c9.jsonl` |
| prod-reality | `agent-ab7002b572d83137b.jsonl` |

Superseded runs, useful for the depth-2 half of the story — these were spawned by the *worker agent*
(`spawnDepth: 2`) before it stalled: `agent-aeb83eed2f68d2e29.jsonl` (blast-radius, stalled),
`agent-a4cd72c0f287ecad0.jsonl` (blast-radius, nested).

**webpieces artifacts** — `/Users/deanhiller/workspace/onetablet/monorepo-nx2-one-2546/.webpieces/pr-review/feature-ONE-2546-context-keys-trusted/`:

- `provenance.json` — the `reviewers: []` record quoted above
- `review-stage.json` — `reviewersBriefed` lists all seven; `mergeValidated: true`
- `review-morpheus-wrapper-*.json` — the seven verdicts, all with `override: ""`
- `review.json` — the author's PR review, written before finish as stage ② requires
- `diff/ALL.diff`, `diff/files/`, `instructions/` — what the reviewers were offered and demonstrably read

**Primary-clone logs** — `/Users/deanhiller/workspace/onetablet/monorepo-nx2/.webpieces/logs/`
(`branch-mutations.log`, `L1-location`, `L2-decisions`, `rejections`, `calls`).

## Suggested fix

The refusal is *correct in intent* — a primary-clone cwd genuinely cannot prove which branch a
reviewer looked at, because the clone moves. The gap is that there is currently **no channel** by
which a legitimately-run reviewer can prove it either. So add one rather than loosening the rule.

**Preferred — record what the reviewer actually read.** The enforcer already computes `readDiff` and
`readDoc` per reviewer (`ReviewerEvidence`, `:70`) by scanning the transcript for reads of
`request.diffDir` / `docPaths`. Those paths are **worktree-absolute** and cannot be produced by a
reviewer that looked at a different branch's materialization. Credit on that instead of on cwd:

```ts
// A reviewer that opened THIS branch's materialized diff, by absolute path, reviewed THIS branch —
// regardless of which cwd the harness stamped it with. Anti-forgery is unchanged: the path is
// worktree-absolute and the diffDir is created fresh per stage-② run.
if (evidence.readDiff && evidence.readDoc) return true;
```

This is strictly stronger evidence than `gitBranch`, which the file's own comment already documents
as unreliable ("a sweep of 961 record-0s … found the mis-stamp is the MAJORITY case").

**Also acceptable, narrower:** allow the cwd fallback when the recorded `cwd` is the primary clone
**and** that clone's `.git/worktrees/<name>` contains a worktree currently checked out to `want`.
That proves the branch was live in the same repo at review time without trusting "what is checked out
now". Weaker than the read-evidence rule; mention only as a fallback if reading evidence is
unavailable.

**Do not** simply un-gate `branchOfCwd` for the primary clone — the stale-reviewer sequence in the
`:373-380` doc block is real and this would reintroduce it.

## Notes for whoever fixes it

- **Fix the stage ②/③ contradiction in the same pass**, independently of the credit rule. When
  verdict files exist but provenance cannot attribute them, stage ③ must not print "did not run …
  spawn each as its OWN subagent". The correct message names the *attribution* failure and its
  remedy, and explicitly says **do not re-spawn** — re-spawning overwrites the verdicts and cannot
  change the outcome. Today's wording guarantees the destructive loop.
- **Fix the count:** `1 checklist(s) require …` printed with seven names.
- **Say how to recover.** With the read-evidence fix the case disappears; until then the only escape
  is re-running the gate from a session whose cwd is the worktree, and nothing in the output says so.
- **Regression test:** a branch in a linked worktree, with all verdict files present, whose reviewer
  record-0s carry the *primary clone's* cwd and a non-matching `gitBranch`, must (a) be credited when
  the transcripts show reads of that branch's `diffDir` and checklist docs, and (b) never emit the
  "spawn each as its OWN subagent" imperative for a checklist whose verdict file already exists.
  Assert (b) separately — fixing (a) alone still leaves the loop-inducing text reachable by any other
  attribution failure.
- **Consider surfacing `spawnDepth`.** A depth-2 reviewer spawned by a worker agent is legitimate,
  but the depth cap means a stalled worker cannot always produce one — which is what pushes the flow
  to the top-level session and into this bug. Worth a line in the docs either way.
