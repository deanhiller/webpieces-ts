# BUG: the BEHIND remedy banner livelocks stage ③ and silently degrades the gate on every iteration

**Status:** §6's SECOND severity (silent gate degradation) is **FIXED**; the livelock itself remains
**UNCONFIRMED** and unreproduced. See §9 for what shipped and what is still owed.
**Reported:** 2026-08-01
**Area:** `packages/tooling/pr-gate` — `wp-finish-upsert-pr`, `FinishBanner`, `PrMerger`

---

## Read this caveat first

We use this flow every day and it does **not** loop — §4's timeline shows why: it takes a *second
author* landing inside our ①→③ window, and we run one author at a time.

**The livelock is still unobserved and §5's repro is still the only thing that would settle it.**
What §9 shipped is deliberately the half that needs no loop: on the FIRST BEHIND, the old banner
ordered a two-step remedy that skipped stage ② and published a PR whose tree no gate had seen. That
part was confirmed by reading the code, not inferred from the loop, and it is fixed.

The analysis below is stated confidently because that is how you make it falsifiable, not because
it has been observed. Where it turned out to be wrong, §3d says so inline rather than being edited
into looking right.

---

## 1. The claim, in one paragraph

`wp-finish-upsert-pr` pushes, calls `gh pr merge`, and GitHub answers
`mergeStateStatus: BEHIND`. The command exits **0** and prints a banner ordering the AI to re-run
stage ① then stage ③ — **skipping stage ②**. Skipping ② is what makes it a bug twice over:
it makes each iteration *more* likely to hit BEHIND again (a positive feedback loop), and it
routes around the merge-validation and review gates while still producing a PR.

## 2. What is NOT true (and was the original suspicion)

The original suspicion was "`wp-finish-upsert-pr` blocks when the branch is behind main, so
developers can never finish." **That is not in the code.** Stage ③ has no staleness precondition:
it never fetches, never runs `merge-base --is-ancestor`, never runs `rev-list HEAD..origin/main`.
Its only two `origin/main` reads are dashboard reporting, through a failure-swallowing helper:

```ts
// finish-upsert-pr-command.ts:294-296  (inside computeDashboardInput)
const forkPoint  = this.gitOut(['merge-base', 'origin/main', 'HEAD']);
const featureHead = this.gitOut(['rev-parse', 'HEAD']);
const mainHead   = this.gitOut(['rev-parse', 'origin/main']);
```

There **is** a fully-written "behind → `exit 1`" hard gate in the repo —
`packages/tooling/pr-gate/src/scripts/workflow/git-validateUpToDate.ts` — but
`git grep validateUpToDate -- packages` returns **zero call sites** and no `bin` points at it.
It is dead code. Worth deleting so nobody wires it in and creates the block we feared.

## 3. Evidence

### 3a. BEHIND is detected only *after* the push, and never throws

```ts
// pr-merger.ts:62-64
isBehind(): boolean {
    return this.mergeStateStatus === GH_STATE_BEHIND;
}
```

Sourced from `gh pr view <base> --json mergeable,mergeStateStatus,state` (`pr-merger.ts:201-211`),
consulted only on the merge-failure path (`pr-merger.ts:139-169`), and returned as a value:

```ts
// pr-merger.ts:174-181
private behindOutcome(state: PrMergeState, queued: boolean): MergeOutcome {
    return new MergeOutcome(false, queued,
        `⛔ did NOT merge — the head branch is BEHIND its base (${state.describe()}).\n` +
        `      BEHIND does NOT self-heal: auto-merge never updates your branch, ...`,
        MERGE_RESULT_BEHIND);
}
```

`MergeOutcome` is **returned, never thrown**. `run()` renders a banner and returns 0.

### 3b. The banner orders a two-step remedy that omits stage ②

```ts
// finish-banner.ts:92-104
private behindRemedy(input: FinishBannerInput): string {
    ...
    '       pnpm wp-start-upsert-pr     # 3-point merge from main — this is what clears BEHIND\n' +
    '       pnpm wp-finish-upsert-pr    # build gate + gated body + merge, now up to date\n\n' +
    ...
}
```

plus `finish-banner.ts:130-134`, which instructs the AI that the PR is not done and its summary
**must** include those commands. So the AI will comply.

### 3c. Why omitting ② is the actual defect

Stage ② (`wp-review-upsert-pr`) is the only stage that does three things: validates the conflict
resolution, runs the build gate, and writes the receipt that records **which sha was verified**.

```ts
// review-upsert-pr-command.ts:79-82
this.receipts.write(repoRoot, featureName, new ReviewStageReceipt(
    scan.basis.headSha, mergeValidated, ..., buildPassedAt, ...));
```

Stage ③ reads it and compares to HEAD:

```ts
// finish-upsert-pr-command.ts:242-249
if (receipt.headSha === headSha) return true;
// Not fatal. ...
process.stderr.write(
    `\n⚠️  HEAD moved since stage ② ran (reviewed ${receipt.headSha.slice(0,8)}, now ${headSha.slice(0,8)}).\n` +
    '   The build gate will re-run, and the PR will record that reviewers judged an earlier tree.\n' + ...);
return false;
```

That `false` is the build-skip decision. So per remedy iteration:

| consequence | mechanism |
|---|---|
| **full rebuild every iteration** | ① moved HEAD → receipt sha ≠ HEAD → `runOrSkipBuildGate` takes the full `nx affected` path |
| **the re-squashed merge is never validated** | validation lives in ②, which the remedy skips |
| **reviewers' verdicts describe an older tree** | ③ only *warns*; it still publishes the PR |
| **branch/dir count grows** | each ① makes a new `merge-<n>/` and a new `<feature>PreMerge<n>` (`merge-start.ts:258-264`) |

### 3d. The window, and why it never shrinks

The window that causes BEHIND is **(time of ①'s `git fetch origin main`) → (time of ③'s push)**.
Any merge B lands on main inside that window makes A's PR BEHIND.

The remedy's window is `① + full build + push`. The *correct* ①②③ remedy's ③-window is
`① + ② + push` where ③'s build is **skipped** (receipt sha matches HEAD), so the build sits
before the fetch instead of after it. Same total work, but only the remedy version puts a full
`nx affected` build **inside** the window.

> **Correction to an earlier draft of this section.** It claimed each iteration *lengthens* the
> window — positive feedback. That is not right, and the timeline in §4 shows why: iteration 1's
> window is usually the *longest* one, because it contains the reviewer round-trip. Iterations
> 2..N all have the same window, a floor of roughly one full build. The accurate claim is weaker
> but still bad: **the window never shrinks below one build**, where the correct remedy would
> shrink it to a push. Each round is an independent coin flip with the same p, so it terminates
> with probability 1 but takes `1/(1-p)` rounds — and as main's merge rate approaches build
> duration, `p → 1` and the expected round count diverges. "Livelock" is the limit case, not the
> mechanism.

## 4. Why we have never seen it — a timestamp timeline

The loop needs **somebody else's merge to land in main during our own ①→③ window**. Here is that
window with a clock on it. **A** is us; **B** is the second author we do not have. Durations are
illustrative — the two numbers that decide severity (build duration vs. main's inter-merge
interval) are what §5 measures.

### Run 1 — the window that opens the bug

| wall clock | actor | event | `origin/main` |
|---|---|---|---|
| `00:00` | **A** | `wp-start-upsert-pr` — `git fetch origin main`, squash A onto it | `M0` ← **window opens** |
| `00:02` | **A** | `wp-review-upsert-pr` starts: validates the merge, runs the build gate | `M0` |
| `00:08` | **A** | build green; receipt written with `headSha = a1` | `M0` |
| `00:08` | **A** | reviewers spawned, `review.json` written | `M0` |
| `00:13` | **B** | lands PR #B1 | **`M1`** ← the only event that matters |
| `00:17` | **A** | `wp-finish-upsert-pr`: `receipt.headSha == HEAD` → **build skipped**, push | `M1` |
| `00:18` | GitHub | `gh pr merge` → `mergeStateStatus: BEHIND` (A forked at `M0`, base is `M1`) | `M1` |
| `00:18` | **A** | **exit 0**, banner: `⛔ PR NOT FINISHED` + re-run ① then ③ | ← **window closes, 18 min** |

B had an 18-minute target and hit it. With one author, `origin/main` is `M0` on every row of that
table by construction — nobody else can move it — so `mergeStateStatus` is never `BEHIND`,
`behindOutcome()` is never constructed, and the banner has never printed for us. **That is the
whole explanation for the empty observation record.** It is not that the code path is guarded; it
is that our concurrency is 1.

### Run 2 — what the banner's remedy actually does

| wall clock | actor | event | `origin/main` |
|---|---|---|---|
| `00:18` | **A** | ① re-runs: fetch → `M1`, re-squash, new `merge-2/`, new `<feature>PreMerge2` | `M1` ← **window re-opens** |
| `00:18` | **A** | HEAD moves `a1` → `a2` | `M1` |
| `00:20` | **A** | ③ (banner skipped ②) — `receipt.headSha (a1) != HEAD (a2)` → `⚠️ HEAD moved` | `M1` |
| `00:20` | **A** | **full `nx affected` build re-runs — inside the window** | `M1` |
| `00:24` | **B** | lands PR #B2 | **`M2`** ← wins again |
| `00:26` | **A** | push, `gh pr merge` → `BEHIND` again | `M2` ← window ≈ 8 min |

Two things to read off run 2:

1. **The window shrank from 18 min to 8 min** — because the reviewer round-trip is gone, not
   because anything improved. It will not shrink further; 8 min is the build. This is the §3d
   correction in table form.
2. **The PR that run 2 pushes was never validated by ②.** The re-squash onto `M1` at `00:18` had
   its conflict resolution checked by nobody, and the reviewer verdicts in `review.json` describe
   tree `a1` while the PR now carries `a2`. Only a stderr line says so. This happens on the
   **first** BEHIND — no loop required — and is §6's second severity.

### The contrapositive, stated plainly

Everything above needs `B` to exist. Our observation record is therefore **consistent with both**
"the analysis is right and we are simply single-threaded" and "the analysis is wrong." The
timeline does not confirm the bug; it explains why the absence of sightings is not evidence
against it. Only §5 discriminates.

## 5. Reproduction — needs two actors

You need a **second author** (a second human, a second worktree with a second `gh` identity, or
just you playing both roles in two terminals). Call them **A** (loops) and **B** (moves main).

1. **A:** branch off `origin/main`, make a trivial change, commit.
2. **A:** `pnpm wp-start-upsert-pr` then `pnpm wp-review-upsert-pr`, spawn reviewers, write
   `review.json`. **Stop before stage ③.** Note the sha in
   `.webpieces/<PR_REVIEW_DIR>/<feature>/review-stage.json`.
3. **B:** land an unrelated PR to `main` **now**. Confirm `origin/main` moved.
4. **A:** `pnpm wp-finish-upsert-pr`.
   - **Expected if the report is right:** the PR is pushed and updated, `gh pr merge` does not
     merge, and the banner prints `⛔ PR NOT FINISHED — the branch is BEHIND main` +
     `DO NOT WALK AWAY` + the two-command remedy. Exit code is **0**.
   - **Expected if the report is wrong:** it merges, or it blocks with a different message.
     Record what actually printed and close this ticket.
5. **A:** follow the banner literally — `pnpm wp-start-upsert-pr`, then `pnpm wp-finish-upsert-pr`.
   Watch for: the build gate running in full (not "already green"), and the
   `⚠️  HEAD moved since stage ② ran` warning. Both appearing confirms §3c.
6. **B:** land another PR *while* A's step-5 build is running.
7. Repeat 5–6. If the banner prints every time, the livelock is real and observed.

**Instrument it:** record wall-clock for step 5, and `git rev-parse origin/main` before and after.
The comparison that matters is *build duration* vs *inter-merge interval on main*. If build time
exceeds the interval, the loop cannot converge; if it is well under, it converges in one or two
iterations and the severity drops to "wasteful + silently degrades the gate", not "livelock".

**Verify independently, do not trust the banner:**
`gh pr view <n> --json mergeable,mergeStateStatus,state`

## 6. Severity if confirmed

Two separate severities, and the second does **not** require the loop:

- **Livelock (needs a busy main):** never terminates while main moves faster than the build.
- **Silent gate degradation (happens on the FIRST BEHIND, always):** the remedy produces a PR
  whose merge was never validated by ② and whose reviewer verdicts are for a pre-re-sync tree,
  with only a stderr warning. This is the part worth fixing even if the loop is unreproducible.

## 7. Candidate fixes — NOT decided, do not implement yet

1. **Fix the remedy to the full ①②③.** Smallest change. Restores validation, and ③ then *skips*
   its build (receipt sha matches), which shortens the window instead of lengthening it —
   it breaks the feedback loop rather than just surviving it.
2. **Move the freshness assertion into stage ②**, per the original instinct: ② fetches and asserts
   the merge is finished and the branch sits on latest main, recording `mainHead` in the receipt.
   ③ stays a non-blocker. Warn-not-block at ②, or ② becomes the new loop.
3. **Bound the retries.** Count consecutive BEHIND outcomes in the PR dir; after N, stop ordering
   a re-run and hand to a human: "main is moving faster than your build gate." Guarantees
   termination regardless of which of the above lands.
4. **Delete `git-validateUpToDate.ts`** — dead hard gate, an attractive nuisance.

5. **Tell the AI that BEHIND is a normal concurrency outcome, not a failure of its work.**
   Today an agent that hits this banner has no framing for it. `⛔ PR NOT FINISHED` +
   `DO NOT WALK AWAY` reads as "you broke something," so the agent's likely reactions are the
   wrong ones: re-audit its own diff, re-run the build hunting a flake, or conclude the branch is
   corrupt and start over. None of that helps — the branch is fine, somebody else merged. The
   framing it needs is one paragraph:

   > Another author landed on `main` between your ① and your ③. Your commits, your build and your
   > review are not in question. Re-sync and re-verify: `wp-start-upsert-pr` →
   > `wp-review-upsert-pr` → `wp-finish-upsert-pr`. If this repeats more than twice, main is
   > moving faster than your build gate — stop and tell the human; do not keep iterating.

   Two places, and they are not interchangeable:
   - **`packages/tooling/rules-config/templates/webpieces.git-workflow.md`** — the *source* of the
     `.webpieces/instruct-ai/` copy. Never edit `.webpieces/instruct-ai/webpieces.git-workflow.md`
     directly; it is regenerated on every `wp-*` run and your edit vanishes.
   - **`finish-banner.ts:92-134`** (`behindRemedy`) — the banner is what the agent actually reads
     at the moment it is deciding, so the framing has to be *there*, not only in a doc it may not
     re-read. This is the same edit as option 1: fix the command list to ①②③ and add the "this is
     normal" sentence in one change.

Options 1, 3 and 5 are independent of whether the loop reproduces; option 1 alone fixes §6's second
severity, and option 5 is worth doing even if we decide the loop is a non-issue — the current
banner mis-directs an agent regardless.

## 8. Open questions

- Does GitHub compute `mergeStateStatus` fast enough after a force-push that stage ③'s read is
  even trustworthy? `pr-merger.ts:208` returns all-`''` on `gh` failure, so a blip cannot *cause*
  a false BEHIND — but an `UNKNOWN`→`BEHIND` race right after the push might.
- ~~Does `pr-gate.mergeMode = "NONE"` (`pr-merger.ts:102-107`) make this moot for us?~~
  **ANSWERED, 2026-08-01: no.** `webpieces.config.json:284` sets `"mergeMode": "AUTO"` (the `Why`
  on line 283: this repo wants `wp-finish-upsert-pr` to land PRs so the `--subject/--body-file`
  reach main's history). AUTO is exactly the mode that queries `mergeStateStatus` and can reach
  `behindOutcome()`. The path is live for us.
- Under option 2, what should ② do when it finds the branch behind — warn, or block? Blocking
  moves the loop earlier and cheaper (no push, no PR churn) but is still a loop.

---

## 9. What shipped (2026-08-01)

Fixes options 1 and 5. Options 2, 3 and 4 are NOT done.

### 9a. `gh pr update-branch` was evaluated and REJECTED

The obvious one-command fix — GitHub's own "Update branch" button — is a trap, and understanding why
is the load-bearing part of this ticket.

- Its **default (merge) mode is already banned** by `checkMergeCommits`
  (`git-findForkPoint.ts:107-133`), which hard-fails any merge-from-main on the branch.
- Its `--rebase` mode does **not** corrupt the fork point, because nothing reads a *recorded* one:
  `ForkPoint.resolveForkPoint` (`git-findForkPoint.ts:42-49`) and `DEFAULT_BUILD_COMMAND`
  (`build-affected.ts:11`) both compute `git merge-base origin/main HEAD` live against the **local**
  HEAD. `update-branch` rewrites only the **remote**.
- **That is exactly why it fails.** It forks reality in two and our machinery is blind to the remote
  half: (1) stage ③ force-pushes local over remote, silently **reverting** the rebase; (2) the
  recorded hash points (`updatemain-hashes.json`, dashboard `Fork point (A)`) describe the old tree
  while the PR head is the new one; (3) the rebased tree **never passes a build gate** — `nx affected
  --base=<old fork>` never saw the other author's files.

There is no shortcut that preserves the 3-point invariant. Only ① moves the fork point *and records
it*; only ② rebuilds and re-receipts against the new one.

### 9b. One BEHIND became three, on the `mergeable` field we already fetched

`prMergeState` has always asked for `mergeable,mergeStateStatus,state` and `isBehind()` read only
`mergeStateStatus`. `PrMergeState.behindKind()` now reads the other half:

| result | GitHub says | what is true |
|---|---|---|
| `BEHIND_CLEAN` | `mergeable: MERGEABLE` | queue collision; nobody touched your lines |
| `BEHIND_CONFLICTING` | `mergeable: CONFLICTING` | real resolution owed; genuinely repeats under load |
| `BEHIND_UNKNOWN` | `mergeable: UNKNOWN` / unreadable | GitHub is still computing — **never** read as clean |

`UNKNOWN` is its own outcome on purpose: GitHub computes mergeability asynchronously and we ask
seconds after a force-push, so it is the *ordinary* reply in our exact situation.

### 9c. The banner stopped blaming the author, and now ASKS

- `⛔ PR NOT FINISHED` → `⏸️  PR IS UP AND GREEN`. Everything stage ③ owns *succeeded*; another author
  landed on main. The old header sent agents re-auditing their own diff for a race they did not cause.
- `BEHIND_CLEAN` carries the caveat that this may not even matter — "out of date" blocks a merge only
  where branch protection **requires** up-to-date branches.
- The remedy is the **full ①②③**, with `Do NOT skip ②` and an explicit warn-off of
  `gh pr update-branch` naming the force-push revert.
- **It asks instead of ordering** — `STOP HERE AND ASK THE HUMAN` + a scripted question, and
  `linkDirective` now requires the AI to *end by asking*. This is the anti-loop mechanism: an
  imperative list is what turns an agent into a retry loop, and asking forces a stop at a human. It
  replaced candidate fix 3 (a retry counter), which is now unnecessary.
- `BEHIND_UNKNOWN` asks a *different* question — re-check first — because proposing a full re-run for
  work we cannot yet show is needed is itself the waste this ticket is about.

Touched: `pr-merger.ts`, `finish-banner.ts` + both specs. `build-all` green (27 projects, 280 tests).

### 9d. Still owed

- **The repro (§5) is still the only thing that settles the livelock.** Nothing here confirms it; the
  fix targets §6's second severity, which needs no loop.
- **Option 2** (freshness assertion in stage ②) — undecided.
- **Option 4** — `git-validateUpToDate.ts` is still dead code with zero call sites. Delete it.
- **A real gap found while investigating:** the merge-from-main guard runs ONLY in the merge flow.
  `findForkPoint` has one caller (`git-gatherInfo.ts:62`, `'merge'`); `findForkPoint('review')` has
  **zero**, making the `workflow === 'review'` branch of `forkPointOutputDir` dead. `resolveForkPoint`
  — what the review diff and `nx affected` use — is documented as unable to throw. So
  `wp-review-upsert-pr` on a main-polluted branch hands reviewers other people's work. That is the
  fork-point invariant doc's own consumer #3, unguarded. Deserves its own ticket.
- **`review.json` reuse (`RUN_ONCE_PER_BRANCH`)** is requested and not started. Note for whoever takes
  it: the `old-review.json` rotation people assume exists **does not** — nothing renames, archives or
  deletes `review.json`, and `.webpieces/pr-review/<feature>/review.json` already persists per branch.
  The only missing piece is a reader that skips when it is present. Tension to resolve explicitly:
  reusing a verdict across iterations is §6's degradation *on purpose*, so it must be DECLARED in the
  PR body and dashboard ("reviewed at sha X, head is Y"), not silent. And per CLAUDE.md's
  publish-first rule the `webpieces.config.json` key must land in a SEPARATE, later PR than the code.
