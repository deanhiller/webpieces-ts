> # ✅ RESOLVED — re-vetted **2026-08-10**, does not reproduce. Kept as a forensic record only.
>
> Both mechanisms this report describes were fixed by the two PRs that landed immediately after it was
> filed. Nothing below is actionable; the numbers and transcripts are retained because they are the
> measurement that justified those fixes, and because §5's debunking of `NX_PARALLEL=1` is still the
> reason nobody should re-add it.
>
> **The §1 mechanism (the 60 s `onTaskUpdate` deadline) is gone — it was an upstream bug, not load.**
> `63d1027` (#535) upgraded `vitest` `3.2.4` → `4.1.10`. The report's premise — *"`DEFAULT_TIMEOUT = 6e4`
> … with **no config knob**"* — was correct but incomplete: vitest's `forks.ts` passed the `node:v8`
> module in as birpc options, `v8` has no `timeout` property, so birpc silently fell back to the 60 s
> default (vitest-dev/vitest#8164). Upstream #8297 passes `timeout: -1`, shipped in `4.1.6`. The deadline
> no longer exists at any wall time, which retires recommendations **B.4, B.5, B.6, B.7, C.10** — every
> one of them bought headroom under a limit that is no longer there. `vitest.config.mts` carries the full
> reasoning and the "do not downgrade below 4.1.6" note; that comment block is the durable fix.
>
> **Re-measured under the exact reported condition.** 2026-08-10, 16-core Mac, **three concurrent linked
> worktrees** off one `.git` with sibling agents running their own suites, 5–10 concurrent `vitest`
> processes:
>
> ```
> $ pnpm nx run-many -t test -p rules-config pr-gate --skip-nx-cache
>  Test Files  39 passed (39)
>       Tests  452 passed (452)
>    Duration  161.88s
>  NX   Successfully ran target test for 2 projects
> ```
>
> **161.88 s — 2.7× past the 60 s cliff this report identifies as the binding constraint — exit 0, zero
> `Timeout calling "onTaskUpdate"`.** These are the same two projects §1 measured at 60.5 s and 73.8 s and
> called the only two that ever failed. Under the old deadline this run could not have passed.
>
> **The §7 shared-state mechanism is gone too.** `925962c` (#533) — which is, note, the very commit this
> report lists as its "Version seen" — introduced `DotWebpieces` (`rules-config/src/state-dir.ts`), the
> single resolver with two explicit scopes: `shared()` → `<primary>/.webpieces`, `local()` →
> `<primary>/.webpieces/worktrees/<git worktree name>/`. `3f7a93d` (#632) then made tree identity come
> from git's own `--git-dir` / `--git-common-dir` rather than a derived path. Audited 2026-08-10: exactly
> three paths are `shared()` — `merged-branches.json`, `main-sync-status.json`, `main-sync.lock.json`,
> all repo-wide facts by design — and everything else is `local()`, including the build-gate log, the
> merge-info state, `pr-review/`, `instruct-ai/` and every log stream. No gate state is keyed by anything
> two worktrees can collide on.
>
> **The nx-discovery hazard is closed.** `de6c0ac` (#625) added the narrow `.claude/worktrees/` entry at
> `.gitignore:115` — narrow on purpose, since `.claude/agents/**` and `.claude/review/**` are tracked and
> define the required reviewer. Verified with three live worktrees: `nx show projects` returns 28 with
> zero duplicates, so nx is not walking the nested checkouts.
>
> **What was NOT a code defect and remains true:** the workflow findings in **A.1–A.3** (cap concurrent
> agents, never propagate an unmeasured workaround, no unattended retry loops) and §6's self-inflicted
> waste. Those are orchestrator and prompt concerns, not repo code, and no PR can close them.
>
> The remaining §7 observations were each filed as their own backlog entries and are tracked there.

# BUG: eight parallel subagents in worktrees collapse the build gate — a green test suite exits non-zero, and every agent reads it as "I broke something"

**Package:** `vitest@3.2.4` (worker→reporter RPC) + `@webpieces/pr-gate` (`wp-review-upsert-pr` build gate)
+ the git-spawning tooling specs (`packages/tooling/rules-config`, `packages/tooling/pr-gate`)
**Version seen:** repo at `origin/main` `925962c`; `vitest` `3.2.4`; mitigations from #473 and #528
(`reporters: ['dot']`, `pool: 'forks'` / `maxForks: 2`, `testTimeout: 15_000`) **already in the tree and
still insufficient**.
**Reporter context:** hit live **2026-07-30**, 06:05–07:37 local, on a 16-core / 64 GB Mac
(`sysctl hw.ncpu` = `16`, `hw.memsize` = `68719476736`). Eight subagents ran concurrently in linked
worktrees off one `.git`. **Five were killed mid-retry-loop.** Evidence below is quoted from their
JSONL transcripts under
`/private/tmp/claude-501/-Users-deanhiller-workspace-personal-webpieces-ts40/436266d1-…/tasks/`.
**Severity:** High — ~6.6 agent-hours burned in one morning, zero of it on the actual features. The
failure mode is silent-by-construction: the gate reports failure on runs where **every test passed**.

**Source:** `vitest.config.mts` (root), `packages/tooling/rules-config/src/main-sync-status.spec.ts`,
`packages/tooling/pr-gate/src/scripts/workflow/checklist-scanner.spec.ts`,
`packages/tooling/pr-gate/src/scripts/*` (the `wp-review-upsert-pr` gate output)

---

## 1. The mechanism, in one paragraph

The tooling suites drive real `git` through `execSync`, which **blocks the worker's event loop**. Each
worker answers an `onTaskUpdate` RPC per test, and the main process must reply within a deadline that is
a **hardcoded 60 s in vitest 3.2.4** — `DEFAULT_TIMEOUT = 6e4` in
`vitest/dist/chunks/index.B521nVV-.js`, with **no config knob**. When a project's wall time approaches
60 s, the reply is missed and vitest fails the run with `[vitest-worker]: Timeout calling "onTaskUpdate"`
**while printing `0 failed`**. Nx then labels the task **flaky**, and the gate exits non-zero.

The binding constraint is therefore **per-project wall time vs a fixed 60 s deadline** — not CPU load as
such. Load matters only because it inflates wall time. This is the key to reconciling the contradictory
readings in §4.

The `testload` agent measured the cliff directly:

> with 'dot' in place, a `nx run-many --target=test --all` at load average 48 on 16 cores still lost
> rules-config (22/22 files green, 60.5s) and pr-gate (21/21 green, 73.8s) to this timeout, while
> **every project finishing under ~13s survived**.

`rules-config` at 60.5 s and `pr-gate` at 73.8 s sit *on or past* the 60 s line. Everything else clears it.

---

## 2. Measured timeline

All times local (transcript `timestamp` fields, UTC−3 offset applied consistently across agents).

| Agent | First gate/`build-all` | Last attempt before stop | Span | Fate |
|---|---|---|---|---|
| `landpr` (run 1) | 04:42:37 | 04:51:09 | **8 min** | **Completed clean — alone on the box** |
| `gitexec` | 06:17:20 | 07:19:33 | **62 min** | killed in a retry loop |
| `stage2` | 06:17:48 | 07:26:20 | **69 min** | killed |
| `landreexec` | 06:24:28 | 07:25:06 | **61 min** | killed |
| `testload` | 06:09:40 | 07:24:44 | **75 min** | killed |
| `methodlines` | 06:33:42 | 07:28:35 (**green**) | **55 min** | killed, resumed, completed |
| `shareddot` | 06:40:51 | 07:37:15 | **56 min** | killed mid-`sleep` after committing `68c717b` |
| `landpr` (run 2) | 06:23:23 | 07:22:06 | **59 min** | killed |
| `forkpoint` | 07:14:27 | 07:31:01 (**green 1st try**) | **17 min** | completed — ran *after* the pause |

**`landpr` is a natural experiment.** The same agent, same repo, same gate:

- **04:33–04:51, alone**: `build-all` → `wp-start-upsert-pr` → `wp-review-upsert-pr` → `wp-finish-upsert-pr`, each ~1 minute apart,
  every stage first try. It even hit **genuine** `ai-hook-rules:test` failures at 04:46:38, fixed them
  in code, and moved on. Total 18 minutes.
- **06:20–07:22, with seven siblings**: ~59 minutes, **42+ gate invocations**, never green, killed.

Nothing about the agent or the branch changed. Only the number of concurrent siblings did.

---

## 3. Failure taxonomy with counts

Occurrences of `Timeout calling "onTaskUpdate"` per transcript (54 total across the eight):

| Agent | (a) `onTaskUpdate` RPC flake, all tests passing | (b) genuine test/lint failure | (c) exit 130 / SIGINT | (d) real spec timeout | (e) other |
|---|---|---|---|---|---|
| `testload` | **28** | 0 | 0 | 0 | — |
| `gitexec` | **13** | 0 | 2 | 0 | — |
| `stage2` | **6** | 0 | 2 | 0 | — |
| `methodlines` | **6** | 1 (own `max-method-lines` work) | 0 | 0 | — |
| `landpr` | **5** | 1 (real, run 1 @ 04:46) | 0 | **2** (`main-sync-status.spec`) | — |
| `shareddot` | **4** | 0 | 3 (exit 130) | 0 | — |
| `landreexec` | **2** | 1 (`rules-config:lint`) | 2 | 0 | — |
| `forkpoint` | **1** | 1 (real lint error) | 3 (exit 130) | 0 | — |

**(a) dominates: ~54 of ~62 classifiable gate failures.** Verbatim, from `landpr`:

> `Timeout calling "onTaskUpdate"` — **324/324 tests and 22/22 files pass, exit code still nonzero**,
> hit on nearly every run

**(c) exit 130** is the same event surfacing differently — nx tears the task tree down and `pnpm`
reports `ELIFECYCLE Command failed with exit code 130.` (twice, always duplicated). Seen in
`gitexec` L127 06:22:26, `stage2` L170/L187/L208, `landreexec` L230/L236, `forkpoint`.

**(d) is the only genuinely slow-test failure**, and it is real:
`packages/tooling/rules-config/src/main-sync-status.spec.ts` was measured by `testload` at **64.6 s**
for the file, against a `testTimeout: 15_000`. `landpr` saw two of its tests fail
(`records the REAL checked-out branch (not an env var)`, `flags conflict=false when main and the branch
touched different files`) and confirmed:

> It passes 22/22 in isolation.

`testload`'s per-file timings under load — the fix list, ranked:
`main-sync-status.spec.ts` **64.6 s** · `checklist-scanner.spec.ts` **40.6 s** · `branch-archiver.spec.ts`
**31.5 s** · `diff-scope.spec.ts` **27.3 s** · `git-exec.spec.ts` **14.4 s** · `diff-materializer.spec.ts` **9.8 s**.

---

## 4. Contention evidence — and reconciling load 28 vs load 4

Load averages read directly from `uptime` in the transcripts:

| Time | Agent | `load averages` |
|---|---|---|
| 06:06:25 | `testload` | 11.23 11.18 15.92 |
| 06:09:32 | `testload` | 28.75 19.65 18.46 |
| **06:11:55** | `testload` | **51.33 30.20 22.71** ← peak |
| 06:16:53 | `testload` | 48.35 37.72 27.15 |
| 06:51:34 | `gitexec` | 29.36 30.36 30.52 |
| 07:01:16 | `landpr` | 9.37 16.29 23.73 (**25 vitest processes**) |
| 07:04:39 | `methodlines` | 6.21 11.63 20.13 |
| 07:19:06 | `gitexec` | 29.84 21.76 18.74 |

Peak **51.33 on 16 cores** — a 3.2× oversubscription.

**The reconciliation.** The two readings that look contradictory are not:

- `methodlines`: *"measured load average went 6.21 → 20.71 → **28.79** while I waited."*
- `landpr`: *"Load was 9–24 with 25 sibling vitest processes; **it stayed flaky even at load 4**."*

`landpr`'s own reading at 07:01:16 shows **25 vitest processes at load average 9.37** — process count and
load are decoupled, because most of those processes are **blocked in `execSync` waiting on a `git`
subprocess**, not burning CPU. They contribute wall time without contributing load.

So the mechanism is **not** "CPU saturation causes failure". It is: `rules-config` (60.5 s) and `pr-gate`
(73.8 s) *already sit at the 60 s RPC deadline on an idle machine*. They have no headroom. Any
perturbation — 25 blocked-on-`git` siblings at load 4, or genuine CPU starvation at load 51 — tips them
over. That is exactly why `landpr` still saw it at load 4 and `methodlines` saw it at load 28: **both
were past the deadline, for different reasons.** The two reports are consistent, and both are correct.

---

## 5. The `NX_PARALLEL=1` verdict — the original claim was propagated as fact and never re-verified

The claim originated with PR **#526** and was written into the task prompt of **all eight agents** as
settled:

> **Run it with `NX_PARALLEL=1`** — under parallel agent load, vitest's reporter RPC starves and
> produces `Timeout calling "onTaskUpdate"` failures on runs where every test passed. `NX_PARALLEL=1`
> is the **known-good workaround**.

By 07:20 it had hardened further, into `methodlines`' resumed prompt: *"`NX_PARALLEL=1` is the **proven**
workaround."*

**Every agent that actually measured it found it does not work:**

| Agent | Finding |
|---|---|
| `testload` | *"Critical result: **NX_PARALLEL=1 did NOT fix it** — still timed out, and took **2.3x longer**."* |
| `methodlines` | *"**`NX_PARALLEL=1` did not avoid it.** I used it on every run. It bounds *my* nx concurrency, but the starvation was external."* |
| `landpr` | *"`NX_PARALLEL=1` did not help — the starvation is in vitest's main-process reporter RPC, not nx's task parallelism, and `VITEST_MAX_THREADS=2` didn't help either."* |
| `shareddot` | *"`NX_PARALLEL=1` **reduced but did not eliminate** it under concurrent agent load."* |

**Verdict: the #526 claim was mistaken, and the difference is fully explainable.** `NX_PARALLEL=1`
bounds *one agent's own* nx task concurrency. When #526 ran, it was the **only significant load on the
box**, so bounding its own concurrency did drop total load and did make it green — a correct observation
with the wrong causal attribution. With seven siblings, the contention is **external** to the process
being throttled, so the lever does nothing. Worse, it *serialises* the run and **increases wall time
2.3×** (`testload`), pushing each project *further* past the 60 s deadline. **`NX_PARALLEL=1` is
counterproductive under multi-agent load and should be struck from the prompts.**

`gitexec` also tested `VITEST_MAX_THREADS=3` and `VITEST_MAX_THREADS=1` (07:06:36, 07:08:59) — neither
helped, consistent with the pool already being `forks`/`maxForks: 2`, so the thread knobs are inert.

**Note the mitigations already in the tree.** `reporters: ['dot']`, `pool: 'forks'` / `maxForks: 2`, and
the spawn-count work (#473, #528) were **already on main** during the incident — `methodlines` explicitly
re-synced past `#522/#526/#527/#528/#529` and *then* failed the gate four more times. **The existing
mitigations are real but insufficient at this concurrency.**

---

## 6. Self-inflicted waste

**`methodlines` — confessed directly, and it is the cleanest example:**

> I also lost time to a self-inflicted one: **I left a retry loop running in the background and then ran
> the gate in the foreground, so my own two runs competed.** Stopped it.

(Transcript L206 07:27:11 shows it killing background task `binnpynvg`.)

**`gitexec` — the worst case, and it did it twice.**
- 07:01:54 launched a **background** loop of 8 `nx run pr-gate:test` attempts (`run_in_background: true`).
- Then ran `pr-gate:test` in the **foreground** at 07:06:36, 07:08:59, 07:11:17 — while that background
  loop was still running. Two full test suites competing for the same 16 cores, from the same agent.
- 07:14:35 launched a **second** background loop (`for i in a b c d e f`), then sat in
  `sleep 240` / `sleep 420` waiting on it.

**`landpr` — 42+ sequential gate invocations with no change to the tree between them:**
loops of 3 (06:31:05), 4 (06:40:55), **8** (06:48:16), 3 (07:01:23), 20 monitoring iterations (07:06:48),
4 (07:11:31), then a **background loop of 25** at 07:20:07 — running when it was killed. Its own summary:

> I burned a lot of retries on this.

**`shareddot` — burned ~46 minutes almost entirely in `sleep`**, polling a background `build-all`:
`sleep 240` (06:51), `sleep 90` (06:56), `sleep 280` (07:02), `sleep 420` (07:07), `sleep 400` (07:15),
`sleep 400` (07:22), `sleep 500` (07:32 — killed during it). It also ran a `until … do sleep 5; done`
watcher (06:51:12) *and* a background `build-all` (06:53:03) concurrently.

**Aggregate: no agent changed a single line of code between retries.** Every one of these loops was
re-rolling the same dice against a deadline that load had already made unreachable.

---

## 7. Cross-agent interference beyond CPU

**Confirmed: one agent's `pnpm install` ran in the primary clone.** `forkpoint` L59 07:13:04 issued a
bare `pnpm install` with **no `cd` prefix**, and it executed in the primary clone. The agent caught it
two calls later (L62 07:13:16):

```
pwd; ls -d …/webpieces-ts40/node_modules …/webpieces-ts40-forkpoint/node_modules
→ /Users/deanhiller/workspace/personal/webpieces-ts40
  ls: …/webpieces-ts40-forkpoint/node_modules: No such file or directory
  …/webpieces-ts40/node_modules
```

Its own report: *"a consistent prune it did not ask for. Nothing else in the primary clone or the six
sibling worktrees was touched."* The primary clone's `node_modules` is shared by every worktree's
`wp-*` binaries, so this is a shared-state mutation with a blast radius of all eight agents. It appears
to have been benign here, but only by luck.

> **Correction (2026-08-02).** This paragraph originally explained the primary-clone install with
> *"the Bash tool does not persist `cd`"*. That claim is **false and has been removed** — it was a
> repo-wide misconception, corrected in PR #558 and #562. The measured behaviour: a `cd` that stays
> INSIDE the workspace **persists** to later calls, while one that **leaves** it is reset by the
> harness, which announces `Shell cwd was reset to <root>`. A linked worktree is outside, so a bare
> command issued from one really does run in the primary clone — **the observation above stands, only
> its stated reason was wrong.** The fix is unchanged: emit every remedy as `cd <root> && …`.

**Confirmed: version-drift guard fired on shared `node_modules`.** `forkpoint` L47 07:12:18:

```
❌ webpieces version drift: package.json pins @webpieces/nx-webpieces-rules@0.4.499
   but node_modules has 0.4.509. Every OTHER call is blocked until they agree.
```

This is the shared-`node_modules`/per-worktree-`package.json` split: siblings landing version bumps
(#527 upgraded 0.4.499 → 0.4.509) moved `node_modules` under a worktree still pinned to the old version.
A sibling's merge blocked this agent's every call.

**Confirmed: guards judge the wrong tree.** `methodlines`: *"worth knowing that the guard fires on the
**default** cwd, not the one you're working in."* This reproduced for me during this very investigation
(see friction log) and is already filed as
[`bug-bash-guards-judge-the-shell-cwd-not-the-paths-the-command-touches`](./bug-bash-guards-judge-the-shell-cwd-not-the-paths-the-command-touches.md).

**Confirmed: generated `design.*` files conflicted across concurrent branches.** `stage2` L249 07:25:01
ran `grep -c "<<<<<<<" packages/tooling/pr-gate/design.html` followed by a `di-graph-generate` — the
documented regenerate-don't-hand-merge recovery. `gitexec` L165 06:29:15 worked through
`.webpieces/merge-info/staged/dean-fix-gitexec/merge-1/updatemain-packages__tooling__pr-gate__design.html`.

**Not determinable from the transcripts:** I searched all eight for `index.lock`, `shallow.lock`,
`config.lock`, `Unable to create … lock`, and `another git process` and found **zero** hits. There is no
evidence of `.git` lock contention despite eight worktrees sharing one `.git`. Likewise I found no
evidence of a half-written shared file blocking another agent, and no evidence of a guard misjudging a
*sibling's branch* specifically (the cwd misjudgement above is about the primary clone, not a sibling).
These may have occurred without being logged; on this evidence they did not.

---

## 8. What actually cleared it — confirmed

At **07:27:32** the user interrupted `methodlines` mid-tool-use with:

> i think yo uhave conflicts with others so I paused 3 of 5, continue.

The immediately preceding history: `wp-review-upsert-pr` had **failed four consecutive times over ~50
minutes** (06:33:42, 06:44:31, 07:21:33, 07:27:17-interrupted).

Five seconds later, at **07:27:37**, it re-ran the identical command:

```
NX_PARALLEL=1 pnpm wp-review-upsert-pr
```

**07:28:35 — green, in 58 seconds.** No code change. `wp-finish-upsert-pr` at 07:29:00 also passed first
try; PR #530 verified with auto-merge armed.

**Independently corroborated by `forkpoint`**, which started at 07:14 (post-pause) and ran the entire
flow — `build-all`, all three `wp-*` stages — **green first try**, 17 minutes end to end. Its stage-②
output still shows nx noticing the near-miss:

```
Nx detected flaky tasks pr-gate:test rules-config:test
✅ Build passed.
```

i.e. nx's internal retry absorbed it at the lower concurrency rather than failing the gate.

**Confirmed: reducing agent concurrency was the only intervention that worked.** It is also the only one
that was ever tried at the *system* level rather than the per-process level.

---

## 9. Recommended fixes, ranked by impact

### A. Workflow — highest impact, lowest cost

1. **Cap concurrent agents at 3 for any task that runs the build gate.** This is the one intervention
   with a confirmed before/after (§8). 8 agents → 3 took a 50-minute-red gate to green in 58 s.
   Enforce it in the orchestrator, not in prose — prose is what produced the `NX_PARALLEL=1` myth.
2. **Delete the `NX_PARALLEL=1` instruction from every task template.** It is measurably
   counterproductive under load (2.3× slower, still red — §5). Replace with: *"if the gate fails,
   check whether the suite passed before assuming you broke something."*
3. **Ban unattended retry loops in agent prompts.** Two attempts, then stop and report. §6 shows four
   agents burning a combined ~3 hours on loops that changed nothing, two of them competing with
   themselves. A retry loop is only valid if something changed between iterations.

### B. Runner — highest structural impact

4. **Land the `InfraTimeoutReporter`.** `testload` built it and it never merged (`scripts/vitest-infra-timeout-reporter.mts`
   is absent from `main`). It prints nothing on a normal run and speaks up only for the *"every test
   passed and the process still exited non-zero"* shape. **This is the single highest-value fix**,
   because it converts a silent misdiagnosis into a named one — every agent-hour in §2 was spent by an
   agent that reasonably believed it had broken the build.
5. **Make the gate itself classify the failure.** `wp-review-upsert-pr` has the test output; when
   `Test Files N passed` and `Tests M passed` with `0 failed` coexist with a non-zero exit, it must say
   *"infrastructure timeout, not your diff"* and **not** print the `nx affected --target=ci` remedy —
   that line re-runs at the same parallelism and reproduces the flake, which is precisely the loop
   agents fell into.
6. **Shard `rules-config` and `pr-gate` so no project's wall time approaches 60 s.** The deadline is
   not configurable in vitest 3.2.4 (`DEFAULT_TIMEOUT = 6e4`, hardcoded). Projects under ~13 s never
   failed; the only two over 60 s failed constantly. Splitting the two heavy projects into sub-projects
   is a mechanical change that moves both under the cliff.
7. **Consider pinning vitest's RPC timeout upstream** or upgrading past 3.2.4 if a knob exists in a
   later release — worth checking, not verified here.

### C. Test suite — durable, highest effort

8. **Fix `main-sync-status.spec.ts` (64.6 s) first** — it is both the (d)-class real timeout *and* the
   largest single contributor to `rules-config` exceeding 60 s. It builds git repo fixtures per test;
   build once and copy, as #473 already did elsewhere.
9. **Then `checklist-scanner.spec.ts` (40.6 s), `branch-archiver.spec.ts` (31.5 s),
   `diff-scope.spec.ts` (27.3 s)** — same pattern, same cure. Per `testload`'s note in `vitest.config.mts`,
   cost is dominated by **spawn count**, not by work.
10. **Replace `execSync` with async `exec` in the git-driving specs where feasible.** `execSync` blocking
    the worker event loop is the proximate cause of the missed `onTaskUpdate` reply. This is the true
    root fix and the most invasive; items 6 and 8–9 buy the headroom without it.

---

## 10. First-person reproduction — this report's own build gate hit it

Filing this report reproduced the bug it describes. **2026-07-31, in a ninth worktree**
(`webpieces-ts40-contention`), against a **docs-only diff — one new markdown file, zero TypeScript
changed** (the gate itself confirms: `✅ No TypeScript files changed`).

**Attempt 1**, `pnpm run build-all`, starting load average **6.59** with 12 sibling `vitest` processes
already on the box:

```
 NX   Running target ci for 6 projects and 41 tasks they depend on failed
Failed tasks:
- pr-gate:test
 ELIFECYCLE  Command failed with exit code 130.
 ELIFECYCLE  Command failed with exit code 130.
```

**Attempt 2**, isolating the failed task — `npx nx run pr-gate:test --skip-nx-cache`, load average now
**31.36** (my own `build-all` having driven it there):

```
⎯⎯⎯⎯⎯⎯ Unhandled Errors ⎯⎯⎯⎯⎯⎯
Error: [vitest-worker]: Timeout calling "onTaskUpdate"
 Test Files  22 passed (22)
      Tests  239 passed (239)
     Errors  1 error
 NX   Running target test for project pr-gate failed
```

**239 of 239 tests passed. 22 of 22 files passed. The task failed.** This is class (a) exactly as
described in §3, on a diff that cannot possibly have broken a test, and it is the clearest single
artifact in this report: *nothing in that output tells a reader the failure is infrastructural.* An
agent seeing only the `build-all` tail from attempt 1 — which does not even print the test counts — has
no way to distinguish this from having genuinely broken `pr-gate`.

Per this report's own recommendation A.3, I stopped after two identical failures rather than looping.

Two incidental confirmations from this run:
- **Load is self-inflicted by `build-all` itself**: 6.59 → 31.36 on a 16-core box, from one agent, because
  `build-all` fans out across projects. Even a *single* agent can push itself past the cliff — which
  strengthens fix B.6 (shard the heavy projects) over any concurrency-limiting lever.
- It reproduced on a **docs-only** change, so no amount of care in the *diff* protects an agent from it.

## 11. Honest gaps

- **Wall-clock attribution per agent is approximate.** I measured first-gate-to-last-attempt spans; some
  of that time was legitimate investigation (notably `testload`, whose whole task *was* this bug).
- **The exit-130 counts conflate causes.** `ELIFECYCLE … exit code 130` is emitted on teardown and does
  not itself say whether a test failed, timed out, or was interrupted. I classified by the surrounding
  output where present; where absent I counted it as (c) rather than guessing.
- **I could not establish `.git` lock contention at all** (§7) — zero hits across all eight transcripts.
  Absence of logged evidence, not proof of absence.
- **The #526 "made it green and kept it green" claim could not be re-tested**, since #526's transcript is
  not among the eight. My explanation in §5 (it was alone on the box) is inference from the fact that
  every subsequent measurement contradicts it — it is the most parsimonious reading, not a verified one.
