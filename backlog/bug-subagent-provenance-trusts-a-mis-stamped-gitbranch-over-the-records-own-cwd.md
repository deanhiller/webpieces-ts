# BUG: wp-finish provenance gate blocks a legitimately-reviewed PR — subagent `gitBranch` in transcript record-0 is mis-stamped

**Reported:** 2026-08-07 · **Reporter:** Dean (via Claude Code, main session `8ae9e533-fea8-4f17-aa26-0254b1454c39`)
**Severity:** High — blocks `wp-finish-upsert-pr` for a PR whose required review genuinely passed, with no in-flow recovery.
**Component:** `@webpieces/rules-config` → `SubagentProvenanceService` (`src/subagent-provenance.js`), invoked by `wp-finish-upsert-pr`. Upgraded context: `@webpieces/nx-webpieces-rules@0.4.591` (just pulled; node_modules had 0.4.566 before `pnpm install`).

---

## ⚠️ FOR THE WEBPIECES AI / MAINTAINER — please VET this, don't just accept it

Dean's explicit instruction: **treat this as a claim to be challenged, get a 2nd opinion, push back if I'm wrong.** I (the reporting AI) believe the root cause is an upstream Claude Code harness mis-stamp, with a webpieces-side mitigation available. But I could be wrong about where the fix belongs, or misreading the intended contract. Specifically, please confirm or refute:

1. Is `record-0.gitBranch` **supposed** to reflect the subagent's own `cwd` branch? (I'm assuming yes.)
2. Given `record-0.cwd` is present and **correct** in the same record, **should `sidechainOnBranch` derive the branch from `cwd`** (e.g. `git -C <cwd> rev-parse --abbrev-ref HEAD`) instead of trusting the harness-written `gitBranch`? Or is trusting `gitBranch` a deliberate anti-forgery choice I'm underweighting?
3. Is there a **slash-vs-dash** normalization issue I'm missing (see §Evidence)? The stored `branch` is dash-form; real git branches are slash-form; `stripWp` normalizes neither.
4. Am I wrong that this is a harness bug — i.e., is there an **AI-orchestration mistake** (wrong spawn pattern) that actually caused it? I tried to rule that out (§Ruled out), but you have the authority to overturn it.

---

## Symptom

`pnpm wp-finish-upsert-pr` refuses to open the PR, **four independent attempts, identical failure**:

```
these reviewer subagents did not run on this branch (spawn each as its OWN subagent —
do not self-certify): morpheus-wrapper-linear-required
```

…despite the `morpheus-wrapper-linear-required` reviewer running as a **separate subagent and returning GREEN on all four attempts**, with genuine tool-call evidence (real `mcp__Linear__get_issue`/`list_cycles` calls in its transcript — not a fabricated verdict, not self-certification).

Branch: `dean/one-2406-mealco-api-auth-observe-header-constant` (Linear **ONE-2406**), head `b398c8b`.
Nothing was pushed; no PR exists — `wp-finish` fails before the push step.

## Root cause (first-hand evidence)

`SubagentProvenanceService.verifyDistinct` → `findMatchingAgentId` → **`sidechainOnBranch(dir, agentId, branch)`** credits a reviewer only when its transcript record-0 `gitBranch` matches the target branch:

```js
// subagent-provenance.js
const gitBranch = rec['gitBranch'];
if (typeof gitBranch !== 'string' || gitBranch === '') return true;   // lenient ONLY when missing/empty
return this.stripWp(gitBranch) === this.stripWp(branch);              // stripWp only removes a -wpN suffix
```

The reviewer subagent's record-0 (read directly from
`~/.claude/projects/-Users-deanhiller-workspace-onetablet-monorepo-nx3/8ae9e533-fea8-4f17-aa26-0254b1454c39/subagents/agent-adc00ee641f48ce4d.jsonl`):

| field | value | correct? |
|---|---|---|
| `isSidechain` | `true` | ✅ |
| `sessionId` | `8ae9e533-…` | ✅ |
| `cwd` | `/Users/deanhiller/workspace/onetablet/monorepo-nx3/.claude/worktrees/agent-a6c10e673cc1469de` | ✅ (this worktree IS on `dean/one-2406-…`) |
| **`gitBranch`** | **`worktree-agent-a54887200e40eb956`** | ❌ **an unrelated, still-live worktree's scaffold branch** |

meta (`agent-adc00ee641f48ce4d.meta.json`): `agentType: morpheus-wrapper-linear-required`, `spawnDepth: 2`, `parentAgentId: a6c10e673cc1469de`.

So **the harness wrote a `gitBranch` that contradicts the record's own `cwd`.** `git worktree list` confirms:
- `…/worktrees/agent-a6c10e673cc1469de  b398c8b [dean/one-2406-mealco-api-auth-observe-header-constant] locked`  ← the reviewer's actual cwd/branch
- `…/worktrees/agent-a54887200e40eb956  580ae25 [worktree-agent-a54887200e40eb956]`  ← the branch that was wrongly stamped (a *different*, completed agent's leftover worktree)

The mis-stamp is **deterministic**: every attempt (#2/#3/#4) recorded the same wrong `worktree-agent-a54887200e40eb956`, regardless of concurrency. The parent (mealco-api-auth) agent's own top-level record likewise showed `gitBranch: "main"` while its `cwd` was correctly its worktree — so whatever computes `gitBranch` for a Task-spawned subagent is **not** reading `git branch --show-current` from that subagent's `cwd`.

`stripWp` (only strips `-wpN`) cannot bridge `worktree-agent-a54887200e40eb956` → `dean-one-2406-…`, so the reviewer is never credited → `provenance.json` `reviewers: []`, `provenanceStatus: "missing"` → **BLOCK**.

Provenance record: `.webpieces/worktrees/agent-a6c10e673cc1469de/pr-review/dean-one-2406-mealco-api-auth-observe-header-constant/provenance.json` (`branch` stored **dash-form** `dean-one-2406-…`; git branch is **slash-form** `dean/one-2406-…`).

## Candidate fixes (for you to weigh)

- **Upstream (Claude Code harness):** stamp record-0 `gitBranch` from the subagent's own `cwd` (`git -C <cwd> rev-parse --abbrev-ref HEAD`), so it can't diverge. This is the true root cause — the field is harness-written, not webpieces- or model-written.
- **Webpieces-side robustness (recommended regardless, because you can't ship an upstream fix):** in `sidechainOnBranch`, when `gitBranch` is present but **doesn't match**, fall back to deriving the branch from the record's `cwd` before declaring a mismatch — the correct `cwd` is right there in the same record. The service already documents that this field is "undocumented Claude Code internals" and is "already lenient for exactly this reason"; today's leniency only covers *missing/empty* `gitBranch`, not *present-but-wrong*. Extending it to "present-but-wrong → verify via cwd" closes the gap without weakening the integrity signal (cwd → worktree → branch is just as harness-authored).
- **Also check normalization:** even with a correct `gitBranch`, a slash-form `dean/one-2406-…` would not `===` the dash-form stored `branch`. If `stripWp` is the only normalization, slashed branch names may be a latent second failure — please confirm the `branch` arg passed into `verifyDistinct` is slash-form at runtime (only the on-disk dir name is dash-sanitized).

## Ruled out (I verified these — overturn me if you disagree)

- **Not self-certification / fake verdict:** the reviewer is a real, distinct `isSidechain:true` subagent, correct `agentType`, `spawnDepth:2`, correct `parentAgentId`, with genuine Linear tool-calls in its transcript.
- **Not concurrency-timing:** retried after sibling worktrees finished; same deterministic wrong branch.
- **Not routed around:** the coding agent correctly refused to self-certify or hand-write a verdict; nothing was pushed.

## Paths for your investigation

- Project (repo root): `/Users/deanhiller/workspace/onetablet/monorepo-nx3`
- Main session transcript: `/Users/deanhiller/.claude/projects/-Users-deanhiller-workspace-onetablet-monorepo-nx3/8ae9e533-fea8-4f17-aa26-0254b1454c39.jsonl`
- Reviewer subagent transcript + meta: `…/8ae9e533-…/subagents/agent-adc00ee641f48ce4d.jsonl` (+ `.meta.json`)
- Provenance record: `<repo>/.webpieces/worktrees/agent-a6c10e673cc1469de/pr-review/dean-one-2406-mealco-api-auth-observe-header-constant/provenance.json`
- Service source: `<repo>/node_modules/@webpieces/rules-config/src/subagent-provenance.js` (`sidechainOnBranch`, `findMatchingAgentId`, `verifyDistinct`, `stripWp`)
- The code the blocked PR carries sits committed (not pushed) at head `b398c8b` in worktree `…/worktrees/agent-a6c10e673cc1469de`.

---

# Resolution — FIXED

**PR:** `dean/fix-subagent-provenance-gitbranch-cwd` · **Fixed in:**
`packages/tooling/rules-config/src/subagent-provenance.ts` (`sidechainOnBranch`) and
`review-provenance.ts` (a mislabelled field), with coverage in both packages' specs.

The report was vetted against LOCAL source (it was written against the PUBLISHED
`node_modules/@webpieces/rules-config/src/subagent-provenance.js`, one release behind). **The defect was
present, unfixed, in local source**, verbatim:

```ts
const gitBranch = rec['gitBranch'];
if (typeof gitBranch !== 'string' || gitBranch === '') return true;
return this.stripWp(gitBranch) === this.stripWp(branch);
```

## Confirmed

**1. `record-0.gitBranch` IS meant to reflect the subagent's own `cwd` branch — and it frequently does not.**
Independently reproduced by scanning **961 subagent record-0s** under `~/.claude/projects` on this machine
and comparing each `gitBranch` against `git -C <record-0.cwd> rev-parse --abbrev-ref HEAD`. Restricting to
subagents running in a DEDICATED `.claude/worktrees/agent-<id>` worktree — where the branch is fixed for
the worktree's whole life, so time-drift cannot explain a difference:

| record-0 `gitBranch` vs its own `cwd`'s branch | count |
|---|---|
| **MIS-STAMPED** | **24** |
| agreed | 6 |
| cwd since reaped (unverifiable) | 39 |

**The mis-stamp is the majority case, 4:1.** A parallel investigation counted **65** mis-stamps across the
same corpus under a wider match. The report's exact record is in that set —
`worktree-agent-a54887200e40eb956` stamped on a reviewer whose cwd was on
`dean/one-2406-mealco-api-auth-observe-header-constant`, appearing **three times** (the retried attempts),
plus a fourth variant `worktree-agent-a448cb06e6d153d66`. Observed wrong stamps include an unrelated live
worktree's scaffold branch, the parent's branch, `main`, a stale feature branch, and the literal `HEAD`.
It is a structural property of how the field is stamped. The reporter's read of the root cause is correct.

**2. Deriving the branch from `cwd` is the right webpieces-side fix.** `cwd` is written by the same harness,
into the same record, by the same writer as `gitBranch` — identical anti-forgery weight — and it is the
field that is *correct*. Adopted, but NOT unconditionally; see "The false-accept" below.

**3. Not an AI-orchestration mistake.** Ruled out independently: the mis-stamp reproduces across four
different repositories and dozens of unrelated sessions on this machine, under ordinary `Task` spawns, and
correlates with no particular spawn pattern.

## Refuted

**The slash-vs-dash normalization concern (§3 of the report) is NOT a latent second failure.** Both sides of
the comparison are already slash-form: the caller passes `git branch --show-current`
(`finish-upsert-pr-command.ts:179` → `provenance-enforcer.ts:78`), and `record-0.gitBranch` holds a real git
branch name. No normalization is missing and none was added.

**But the reporter was right that something was wrong there — it is a MISLABEL, not a conversion.**
`provenance.json` had a field named `branch` that never held a branch: `provenance-enforcer.ts:130` passes
`AiBranchName.getFeatureName()`, i.e. `baseBranchName(branch).replace(/\//g,'-')` — the dash-sanitized
feature slug naming the `pr-review/<slug>/` directory. Reading a dash-form value out of a field called
`branch` is exactly what sent the reporter hunting a normalization defect, and it would have misled the next
reader identically. **The field is renamed to `featureSlug`** in `ProvenanceWriteRequest` and
`ReviewProvenance` (the class field names ARE the JSON keys). Per CLAUDE.md this is a hard surface break —
no dual-read, no `?? branch` fallback; `provenance.json` files are transient gate receipts and nothing reads
the key back, which was confirmed before committing to the break. A spec asserts the new key is present and
the old key is `undefined`.

## The false-accept that the naive fix would have opened

"Ask git what branch the cwd is on" is only sound when that cwd CANNOT have moved since the reviewer ran.
An unguarded fallback would silently credit a STALE reviewer, by construction rather than by accident:

1. a reviewer runs in the PRIMARY CLONE while it is on branch A
2. the clone is later checked out to branch B
3. `wp-finish-upsert-pr` runs on B — `gitBranch` (stamped A) mismatches, so the fallback fires
4. `git -C <clone>` answers **B**, because the CLONE moved → the reviewer is credited for B

It reviewed A. In a repo with a required reviewer on every PR that is the normal sequence, not an exotic
one, and the scan above shows the corpus is full of primary-clone subagents whose `gitBranch` is stale.

**So the fallback is gated on `cwd` being a LINKED WORKTREE** — `dotWebpieces.isLinkedWorktree`, git's own
`--git-dir != --git-common-dir` test, reused from `state-dir.ts` rather than re-derived. A linked worktree is
1:1 with the agent that owns it and is not re-checked-out underneath you; a primary clone is. This still
fixes the reported incident, whose reviewer cwd was `…/.claude/worktrees/agent-a6c10e673cc1469de`. A
dedicated regression test pins it: *cwd = primary clone that has since moved onto the target branch → still
BLOCKED.*

## What shipped

`sidechainOnBranch` now treats a **PINNED `cwd`** as the authority. `gitBranch` is only a cheap way to skip
the subprocess when it already agrees; when it disagrees, git is asked what branch that record's own cwd is
on, and the reviewer is credited only if the cwd is a linked worktree AND that branch matches. Per CLAUDE.md
there is exactly ONE rule and no second spelling — no config flag, no comparison mode, no fallback toggle.

Leniency is bounded by "git can still prove it on a tree that cannot have moved", never by "we could not
check, so assume yes". All of these still BLOCK: cwd is the primary clone, cwd on a different branch, cwd
reaped, cwd not a git repo, no `cwd` in the record, detached HEAD. Results are cached per cwd, because
`findMatchingAgentId` walks every subagent of every session on the machine and many share a worktree.

Eleven tests were added. The crediting tests were verified to FAIL against the pre-fix comparison and pass
after it; every blocking test passes either way, which is the point — they guard against over-crediting.

## Still open upstream

The true root cause is unfixed and lives in the Claude Code harness: it should stamp record-0 `gitBranch`
from the subagent's own `cwd`. This change makes webpieces immune to it; it does not fix it.
