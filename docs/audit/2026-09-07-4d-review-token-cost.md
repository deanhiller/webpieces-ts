# Audit — token spend and the review phase (4 days)

**Scope.** 13 webpieces-governed repos (`ctoteachings/monorepo1-6`, `onetablet/monorepo-nx1-4`,
`personal/webpieces-ts30/40/50`). Window **2026-09-03T00:00:00Z → 2026-09-07T04:18Z UTC**,
fully inside the build ledger's coverage (earliest row 2026-08-21T05:59:13Z).
**63 Claude sessions · 598 subagent runs · 19 Codex sessions · 126,887 guard decisions ·
326 builds · 28 PR cycles.**

> **Revision note.** This replaces the first cut of this report, which carried two errors, both
> found by re-deriving the numbers rather than by anything downstream. They are recorded here
> rather than quietly fixed because one of them changed a headline by 10x.
>
> 1. **Codex `wp-review-upsert-pr` invocations: reported 92, actual 9.** The counter matched the
>    string anywhere in a rollout record, so it counted the model's own reasoning prose, a
>    `ps | rg wp-review-upsert-pr`, and `gh issue create` bodies quoting the command. The error ran
>    in the direction that made the comparison dramatic.
> 2. **The 21x Claude-vs-Codex "tokens per gate run" ratio was built on that 92.** With the real
>    denominator it is **~2x**, and most of the raw difference is that Codex simply did far less
>    work in the window.
>
> The counter is now `wp_invocations()` in the collector, with a test.

---

## 1. Total token spend, 4 days, 13 repos

**14,552,808,000 tokens** (14.55B), of which **98% is `cache_read`**.

| bucket | tokens | share | est. $ | API calls |
|---|---|---|---|---|
| Claude — main agent | 4,037,935,869 | 27.7% | $8,530 | 10,542 |
| Claude — **reviewer** subagents | 1,211,680,914 | 8.3% | $3,507 | 11,177 |
| Claude — other subagents | 9,242,035,027 | 63.5% | $16,738 | 36,900 |
| **Claude total** | **14,491,651,810** | **99.6%** | **$28,776** | 58,619 |
| Codex (all repos) | 61,156,188 | 0.4% | — | 668 |

`est. $` is **Opus list price applied to exact recorded usage** ($15/$18.75/$1.50/$75 per Mtok for
input/cache-write/cache-read/output). It is a relative weighting device, not a bill — your actual
plan pricing differs, and Codex bills on OpenAI's schedule so its column is deliberately blank.

**By repo:**

| repo | tokens | est. $ |
|---|---|---|
| ctoteachings/monorepo1 | 4,242,687,070 | 7,994 |
| ctoteachings/monorepo2 | 3,550,074,432 | 6,917 |
| ctoteachings/monorepo3 | 2,952,267,642 | 5,601 |
| onetablet/monorepo-nx1 | 988,753,823 | 2,144 |
| ctoteachings/monorepo4 | 676,013,381 | 1,400 |
| onetablet/monorepo-nx3 | 495,173,994 | 995 |
| personal/webpieces-ts40 | 485,388,338 | 1,122 |
| personal/webpieces-ts30 | 434,063,392 | 1,037 |
| onetablet/monorepo-nx2 | 306,920,984 | 684 |
| personal/webpieces-ts50 | 251,565,005 | 591 |
| onetablet/monorepo-nx4 | 97,654,311 | 267 |
| ctoteachings/monorepo5 | 11,089,438 | 24 |

**The 98% cache_read share is the single most important number here.** It means this workload is
overwhelmingly re-reading a cached prefix on every agentic turn, which is why 14.5B tokens weighs
in around $29k of list price rather than $200k. It also means the lever that matters is **turns**
and **fan-out**, not prompt size.

---

## 2. Where the tokens actually go — and it is NOT the reviewers

| agent type | tokens | est. $ | share of fleet |
|---|---|---|---|
| **`general-purpose`** (the `/full-cycle` workers) | 8,561,396,793 | 15,221 | **58.8%** |
| main agent (you, driving) | 4,037,935,869 | 8,530 | 27.7% |
| `backend-dev` | 533,251,148 | 1,100 | 3.7% |
| **all 14 reviewer types combined** | **1,211,680,914** | **3,507** | **8.3%** |
| everything else (`Explore`, `Plan`, `db-specialist`) | ~150M | ~430 | 1.0% |

**Answering your question directly: the review phase is 8.3% of your token spend, and the
re-run waste inside it is 5.6%.** If reviewer re-runs were eliminated entirely — perfect caching,
every reviewer runs exactly once per PR — you would save ~815M tokens, ~$2,420 est., **5.6% of the
bill**. Worth doing; it is not what has been killing you.

**`general-purpose` subagents are 58.8%.** 164 runs, ~$92 est. each. That is `/full-cycle` and
friends: an agent in a worktree, ~50 turns deep, re-reading a growing cached context on every turn.
Any real dent in the bill is there, not in the gate.

---

## 3. The review phase, measured properly

*Measured across 0.4.720 / 0.4.723 / 0.4.728 / 0.4.738 / 0.4.739 / 0.4.741 — every release in the
window; `pct_on_latest` is 9%, so this is mostly 0.4.720–0.4.739 behaviour.*

| | value |
|---|---|
| reviewer subagent runs | **380** |
| distinct (parent session × reviewer) pairs | 108 |
| **repeat runs** | **272 (72%)** |
| repeat cost | **815M tokens, ~$2,420 est.** |
| avg per run | 3.2M cumulative tokens, **26 agentic turns**, ~$9.23 est. |
| median startup context | 50,253 tok (monorepos) / ~29,000 (webpieces-ts) |
| **red verdicts in the window** | **0** — 43 green, 6 yellow, over 49 completed `review-*.json` |
| `wp-review-upsert-pr` invocations (Claude, strict count) | **358** |
| PR cycles | 28 |

**Your stated premise did not happen.** *"they reject with red sometimes, agent fixes them and
reruns the agents"* — there was **not one red verdict in four days**. The re-runs are not a fix
loop. They are `wp-review-upsert-pr` being invoked again after an amend/rebase/squash and
**re-briefing the entire checklist from scratch**, with no memory that the same reviewer read
essentially the same diff minutes earlier.

Worst sessions (client repos by session id only):

| repo | session | reviewers | runs | rounds | est. $ |
|---|---|---|---|---|---|
| monorepo3 | `4c001eb2` | 7 | **83** | **11.9** | 806 |
| monorepo2 | `3cd4b27c` | 7 | 54 | 7.7 | 635 |
| monorepo1 | `4da8af5b` | 7 | 39 | 5.6 | 402 |
| monorepo1 | `40a91458` | 8 | 25 | 3.1 | 341 |
| monorepo2 | `06921074` | 6 | 26 | 4.3 | 266 |

One session ran the full 7-reviewer checklist **twelve times**.

**Independent corroboration from `~/.webpieces/builds.log`** — a completely different source:

```
review : 230 builds  383.5 min  (71% of every build on this machine)
build  :  82 builds  142.2 min  (25%)
finish :  14 builds   22.9 min  (4%)
```

Stage ② is designed to build **once** per PR and hand the sha to stage ③. It ran **230 times for 28
PR cycles — 8.2 gate builds per PR.** Same multiplier as the reviewer fan-out, visible in CPU
minutes as well as tokens. So the "run the reviewers once and be done" instinct is right; it is
just worth **$2.4k and 383 build-minutes over four days**, not the bulk of the bill.

**Direction.** Stage ② already records the sha it verified. Key each reviewer's verdict on
`(subagent, headSha, the subset of the diff matching that reviewer's `patterns`)` and skip the
spawn on a hit. On a squash that touches one file, 6 of 7 reviewers become cache hits. The
zero-infrastructure version: only re-spawn reviewers whose `patterns` match files changed **since
the last gate run**.

---

## 4. Codex — corrected

| | Claude Code | Codex |
|---|---|---|
| sessions in window | 63 | 19 |
| **subagent transcripts written** | **598** | **0** |
| distinct threads per session | n/a | **1, in all 19** |
| `wp-review-upsert-pr` (strict count) | **358** | **9** |
| `wp-finish-upsert-pr` | 239 | 5 |
| total tokens | 14,491M | 61M |

**Confirmed: Codex never spawns a reviewer subagent.** Every one of its 19 sessions ran on a single
`thread_id`, and there are no subagent transcripts anywhere in `~/.codex/sessions`. It reads the
brief `wp-review-upsert-pr` prints and proceeds inline.

**But that is not why its total is small.** Like-for-like on the same repos (`webpieces-ts*`), per
gate run:

| | gate runs | tokens | tokens per gate run |
|---|---|---|---|
| Claude | 70 | 1,135M | **16.2M** |
| Codex | 8 | 59M | **7.4M** |

**~2x, not 21x.** Codex is genuinely cheaper per PR cycle — no fan-out — but the 240x difference in
total spend is overwhelmingly that **Codex did 9 gate cycles while Claude did 358.** The two are
not doing comparable volumes of work, and any plan that reads "switch to Codex and save 99%" is
reading a workload difference as an efficiency difference.

**The open question worth resolving before you act on this.** Two readings, and token data cannot
separate them:

- **Cheap reading:** the fan-out is optional and Codex proves it. Supporting evidence is strong —
  380 Claude reviewer runs produced **zero** red verdicts.
- **Expensive reading:** Codex is silently skipping a `required: true` checklist and
  `wp-finish-upsert-pr`'s provenance check is not catching it.

Corroborating signal for the expensive reading: **11 guard surfaces have Claude traffic and zero
Codex traffic**, and Codex logged 2,681 guard decisions to Claude's 122,102 — a 45x gap on a 3.3x
session gap. Something on the Codex side is not running that runs on the Claude side.

---

## 5. Collector changes made this session

`.claude/skills/audit-webpieces` could not see any of §1–§3 before today. Changes, all in this
tree, untracked:

- **`wp_audit.py`** — walks `~/.claude/projects/<repo>/<sessionId>/subagents/agent-*.jsonl` with
  the same scanner as a main session, keyed by the sidecar `.meta.json` (`agentType`, `model`,
  `worktreePath`, `spawnDepth`). New `transcripts.tokens` (exact usage, split
  main / reviewer-subagent / other-subagent, with `by_agent_type` and cache_read share) and
  `transcripts.subagents` (runs, reviewer runs, repeat runs and their cost). Codex token spend now
  read from `token_usage_record` instead of reported as 0. New `wp_invocations()` replaces
  substring counting. New `in_token_window()` gates the window START for token sums only — the
  pre-existing `in_window()` deliberately does not, and using it inflated a token total by 69%.
- **`digest.py`** — prints a `## token spend` section ahead of `## return-byte cost`.
- **`SKILL.md`** — documents the subagent tree, the `.claude/worktrees` vs `.webpieces/worktrees`
  split, the invocation-counting rule (with the 7-vs-92 incident), and three new Step-4 judging
  rules including "rank agent types before blaming the gate".
- **`test_wp_invocations.py`** — new, 7 cases, pins the counter against greps, `ps` lines, JSON
  arg lists and prose.

---

## 6. Checked and clean

| area | verdict |
|---|---|
| guard cycles | claude-code 0.4% block rate (552/122,102), 2 streaks, 36.3 blocked-min over 4 days. |
| stale-main health | no `cure-not-taking`; the block that hit this session advanced on the first cure. |
| isolation | no worktree-vs-primary `root=` disagreements. |
| version skew | one finding: `monorepo-nx1` has worktrees on 0.4.685 / 0.4.714 against a 0.4.720 pin, 13 commits behind main — `trinary-version-skew` will block there. |
| matrix conformance | no decision/`act` disagreements, no undocumented fault codes. |
| build ledger | 0 orphaned builds. Killed-and-re-run: a few SIGINT `review` builds, largest 2.6 min for one result. Max concurrency 3, 59.0 overlapped min — contention is **not** what is making these cycles expensive. |
| 3-point merges | no branch re-merged 3+ times, no CONFLICT without a later FINALIZE. |
| doc drift | no missing paths; `build.log` path check clean. |
| Codex parity | **not clean** — 11 surfaces with zero Codex traffic; see §4. |
| return-byte cost | 17.4M chars of tool output, 3.4% re-emissions. Top repeat is a `guard-pkg-unknown` block at 12×1,937 chars. Two orders of magnitude below §3. |
| always-loaded `.md` tax | worst repo monorepo5 at 294,785 chars (~73.7k tok) per session; `monorepo1-5/CLAUDE.md` are 128–132 KB each. Paid again per subagent spawn, but only 17M tokens total (1.4% of reviewer spend) — a session-startup lever, not a review-phase one. |
| cycle time | **RECONCILIATION PASS** (60/67 sessions, worst drift 0.0s). CI coverage PARTIAL, so the 29.0% AI residual is an upper bound. p50 branch→land 19.6 min wall / 14.0 blocking (n=17, below the n=20 bar, so no p75+). |

---

## 7. Audit hygiene

Read-only except this file and the collector changes in §5, with one exception: branching off
`origin/main` moved the pin to 0.4.738 while `node_modules` held 0.4.734, and the L0
`version-drift` guard blocked every tool call. I ran its single prescribed cure, `pnpm install`.
webpieces-ts50's installed version reflects post-cure state.

One guard misfire worth recording: `build-output-pipe-guard` blocked a `python3 - <<'PY'` heredoc
whose *content* contained the literal string `wp-build` and, separately, a `|` character. Nothing
was piped into a build. Working around it cost two round trips.

This report was written to the scratchpad first and copied in. **It is untracked — commit it or a
`wp-review-upsert-pr` in this tree will delete it.**

---

## 8. Levers, ranked by what they actually save

Every % is of the **14,552M tokens / ~$28,776 est.** measured in §1. Token-% and cost-% differ
because reviewers are more output-heavy than the fleet average — both are given.

| lever | saves (tokens) | saves (est. $) | what it costs you |
|---|---|---|---|
| **Cap `/full-cycle` agent turns** (see below) | **20–45%** | 20–45% | some runs need re-driving |
| Shut ALL reviewers off | **8.3%** | **12.2%** | the entire gate checklist |
| Reviewer verdict cache (repeats only) | 5.6% | 8.4% | nothing — pure win |
| Trim always-loaded CLAUDE.md | ~0.1% | ~0.1% | not worth doing for cost |

### Why `/full-cycle` is the lever and the gate is not

| agent class | runs | median turns | max turns | median tokens/run | total |
|---|---|---|---|---|---|
| **`general-purpose`** | 164 | **143** | **1,331** | 19.7M | **8,532M (58.7%)** |
| `backend-dev` | 15 | 148 | 587 | 15.5M | 533M (3.7%) |
| reviewers (14 types) | 342 | **27** | 106 | 2.9M | 1,154M (7.9%) |
| `Explore` | 33 | 49 | 93 | 2.8M | 105M (0.7%) |

A reviewer and a `/full-cycle` worker cost roughly the same **per turn** (111k vs 138k tokens —
both dominated by re-reading a cached context). The 7x difference in cost per run is **turns**:
27 vs 143. That is the whole story.

And the distribution is brutally top-heavy:

| | share of `general-purpose` | share of the WHOLE fleet |
|---|---|---|
| top 5 runs | 25% | **14.7%** |
| top 10 runs | 39% | **22.9%** |
| top 20 runs | 57% | **33.4%** |
| top 40 runs | 77% | **45.1%** |

**Ten agent runs are 23% of four days of token spend.** The largest single one — 1,331 turns,
767M tokens — is **5.3% of the fleet by itself**, one agent, one feature.

Cost grows faster than turn count, because each turn re-reads a context that the previous turns
grew: at 98% cache_read, an agent's Nth turn costs roughly N times its first. A 1,331-turn run is
therefore not 9x a 143-turn run, it is closer to 40x — which is exactly what the table shows.

**Directions worth measuring before building:**

1. **A turn budget per subagent** with a forced checkpoint — summarise, drop the transcript,
   respawn with the summary. Turns 800–1331 in the run above are re-reading 700 turns of history
   nobody will look at again. This is the only lever in the 20–45% range.
2. **Look at what the long runs were doing.** Six of the top ten are `/full-cycle` on a feature;
   the rest are long debugging loops. If a chunk of those 1,331 turns is the agent re-running
   builds or re-greping the same files, that is a cheaper fix than a turn cap.
3. **Shutting reviewers off saves 8.3% and removes every checklist.** The verdict cache gets you
   5.6% of that 8.3% and keeps the checklist. Given 0 red verdicts in 380 runs, the honest question
   is whether the checklist is buying anything — but that is a correctness decision, not a cost
   one, and the cost answer is "either way it is under a tenth of the bill".

---

## 9. Anatomy of the most expensive agent run — it was a POLLING LOOP

**The run.** `ctoteachings/monorepo1`, branch `dean/587-stories-catalogue`, description
*"Catalogue: playable, paged, bylines"*, agent `ab977725ea58298d8`, spawned with its own worktree.
**2026-09-06 13:31:51 → 16:20:45 UTC — 2.8 hours, 1,331 turns, 767M tokens** = 5.3% of the fleet's
four-day spend, in one agent.

**Half of its turns did nothing.**

| | |
|---|---|
| turns | 1,331 |
| **turns whose only tool call was `echo .`** | **666 (50%)** |
| **token cost of those turns** | **465M — 61% of the run, 3.2% of the whole fleet** |
| longest unbroken run of `echo .` | **160 turns** |
| streaks of ≥5 consecutive `echo .` | 12, covering 656 of the 666 |
| first no-op | turn 459 of 1,331 |
| what preceded a no-op | `echo .` (658×), `until [ "$(gh pr checks … grep -c pending)" -eq 0 ]`, `echo waiting-for-reviewers` |
| `Monitor` tool calls in the entire run | **1** |

The command trail says exactly what happened: the agent finished the code, ran the gate, and then
**waited for CI and for the reviewers by burning a turn at a time.** By turn 459 its context was
already ~460k tokens, so every `echo .` re-read half a million cached tokens to learn nothing. The
final turns cost ~791k tokens each. Twelve waits, the longest 160 turns long.

**This is not a turn-count problem, it is a waiting problem.** The harness already has the right
tool — `Monitor` with an until-loop, which is what the system prompt tells an agent to use because
a foreground `sleep` is blocked. This agent called `Monitor` once and hand-rolled the rest.

**The real work in this run was ordinary:** 323 substantive Bash calls, 101 `Edit`s, 16 `Write`s,
12 sub-spawns, 5 `Read`s, 9 `max-file-lines` blocks, 6 `wp-review-upsert-pr` runs, 4 gate builds.
Nothing pathological. Strip the polling and it is a ~665-turn, ~302M-token feature build.

### Fleet-wide

| | tokens | share |
|---|---|---|
| no-op polling turns across ALL subagent runs in the window | **646M** | **4.4% of the fleet** |
| — of which this one run | 465M | 3.2% |
| — second worst (`a491bca2…`, 356 of 594 turns) | 128M | 0.9% |
| all other runs combined | 53M | 0.4% |

1,223 no-op turns out of 48,262 (2.5% of turns) cost 6.2% of subagent tokens — no-ops are twice as
expensive as an average turn, because an agent only starts polling once its context is already
large.

**Two runs are 88% of it.** So this is not yet a fleet-wide habit; it is a failure mode that
appears when an agent has to wait on CI, and when it does it is catastrophic.

### What would have avoided it

In rough order of effort:

1. **A guard that refuses a no-op poll and names `Monitor`.** `echo .`, `echo ..`, `true`, `:` as
   the entire command have no legitimate use in an agent loop, and a `PreToolUse` block costs one
   turn and prescribes the tool that costs zero. This is the same shape as every other webpieces
   guard, it is mechanical, and it would have caught 656 of the 666 turns here (the streaks).
   **Saves ~4.4% of tokens on this window's evidence, and removes the tail risk of a single run
   costing 5% of a week.**
2. **A `/full-cycle` instruction** that names `Monitor` for CI waits explicitly. Cheaper still, but
   an instruction only binds the agents that read it; the guard binds all of them.
3. **A turn budget with a forced checkpoint** — summarise, drop the transcript, respawn. This is
   the general fix for context growth and it is worth having, but note that on THIS run it would
   have been the wrong diagnosis: the turns were not real work that needed compacting, they were
   nothing at all.

### So what actually drives `/full-cycle` cost

Two mechanisms, and they compound:

- **Polling turns** — 4.4% of the fleet, concentrated in two runs. Cheap, mechanical fix.
- **Context that never resets** — the remaining, unavoidable-looking part. In this run, context
  went 79k → 791k and never came down. Even excluding every no-op, the surviving 665 turns
  averaged 454k tokens each. At 98% cache_read the Nth turn costs about N times the first, so a
  long agent's cost is quadratic in its length whatever it is doing. That is what a checkpoint
  strategy attacks, and it is the difference between the 4.4% above and the 20–45% band in §8.

---

## 10. Does compacting fix the burn rate? Partly — and not where you'd type it

### What a compaction actually does (measured, not assumed)

12 real compactions fired in the window, across 4 runs:

| | |
|---|---|
| context immediately before | 966k – 999k |
| context immediately after | 82k – 126k |
| **median drop** | **90%** |
| cost of the compaction itself | one `cache_write` of 62k–72k — negligible |
| when it fired | at ~1M, i.e. the auto-compact ceiling |

So compaction works, it is cheap, and it is already running. **The problem is the threshold.**

**The expensive runs never reach it.** The 767M run in §9 peaked at **791k** — it sat just under the
ceiling for its entire second half and never compacted once. Every long-but-not-enormous agent is
in that same dead zone: expensive enough to hurt, not expensive enough to trigger the cure.

### The concentration is extreme

| | |
|---|---|
| runs in window | 664 |
| **runs peaking over 400k context** | **41 (6%)** |
| **share of all per-turn context those 41 hold** | **62%** |
| top 10 runs | 36% |
| top 25 runs | 55% |

A threshold only has to bind 6% of runs to reach two thirds of the spend.

### Modelled saving from an earlier threshold

Replaying every real per-turn context curve in the window, compacting whenever context crosses a
threshold, using the MEASURED 90% drop and 70k cache_write:

| compact at | modelled total | **saving** | compactions triggered |
|---|---|---|---|
| 150k | 5,449M | **69%** | 373 |
| **200k** | 6,862M | **61%** | 201 |
| 300k | 9,320M | **48%** | 95 |
| 400k | 11,539M | **35%** | 49 |
| 600k | 14,237M | 20% | 16 |
| ~1M (today) | 17,818M | — | 12 |

**These are UPPER BOUNDS.** The model holds turn count constant, and that is the assumption most
likely to be wrong: a compaction drops detail, so an agent can forget a decision and redo work,
adding turns. A 200k threshold that causes 20% more turns nets ~53%, not 61%. It is still by far
the largest lever in this audit — but it needs to be measured after the change, not assumed.

### Why "/compact all of them" is not quite the move

Three reasons, in order of how much they matter:

1. **`/compact` is a main-session command you type. 63.5% of the spend is subagents**, which run
   autonomously in worktrees and finish without you ever seeing them. You cannot `/compact` the
   1,331-turn agent — it was born, burned 767M tokens, and exited inside one of your turns. The
   lever for those is a **threshold**, not a keystroke.
2. **Compacting does not refund anything.** It only makes FUTURE turns in that session cheaper. On
   a session you are about to close it saves nothing.
3. **The main-agent bucket is 27.7%**, and your own sessions are the ones already hitting the ~1M
   auto-compact — three of the four runs that compacted are main sessions. That part is largely
   working.

So: compacting is the right instinct, aimed one level too high. **What to change is the point at
which compaction fires, for subagents especially.**

### The open question before acting

Whether the auto-compact threshold is configurable per-session or per-subagent in this harness is
**not established by this audit** — it is a Claude Code question, not a webpieces one, and guessing
a settings key here would be exactly the kind of hand-copied detail `.claude/rules/no-backwards-compat.md`
warns about. Verify it before designing around it. If it is not configurable, the fallback is a
`/full-cycle` instruction telling worker agents to checkpoint and respawn themselves at a turn or
context budget — same effect, worse ergonomics, and it only binds agents that read the instruction.

---

## 11. Correction to §10, and the exact mechanism of the no-op turns

### 11a. The compactions were mostly MANUAL — §10 called them auto-compact

Re-read with `compactMetadata.trigger`, over all transcripts on disk:

| trigger | n | pre-tokens | post-tokens | drop |
|---|---|---|---|---|
| **auto** | 16 | 974k – 1,007k (a hard ceiling at ~1M) | 17k – 33k | 97–98% |
| **manual** (`/compact`, typed by Dean) | 8 | **174k, 335k, 402k, 439k, 466k, 643k, 757k, 994k** | 12k – 30k | 92–98% |

**The manual ones are the interesting row.** They are Dean deliberately compacting at 174k–466k —
far below the auto ceiling — which is the correct instinct and the very lever §10 recommends. §10
described the ~1M events as "auto-compact already running" and implied the low-water behaviour did
not exist. It does exist; it is a human doing it by hand, in the sessions he happens to be watching.

**Which is exactly why it does not reach the money.** Compaction requires someone watching:

| | protected by | |
|---|---|---|
| main sessions Dean is driving | `/compact` by hand at 174k–466k, plus auto at ~1M | **working** |
| **subagents** | auto at ~1M only — nobody is watching | **not protected** |

The 767M run peaked at **791k**. Below the 1M auto ceiling, so nothing fired; nobody was watching,
so no `/compact`. It ran to completion at three-quarters of a million tokens per turn. That is the
whole gap, in one sentence.

### 11b. What the no-op turns actually were — the precise mechanism

Not "a subagent re-reading the main agent's context". Each subagent has **its own conversation**,
and every API call resends **that agent's entire conversation so far**. There is no incremental
mode: turn 1,000 costs whatever the first 999 turns accumulated, re-sent. At 98% cache_read it is
billed at a tenth of fresh input, which is the only reason this is survivable.

So a turn's cost is set by the SIZE OF THE CONVERSATION, not by what the turn does. `echo .`
returns one byte and costs the same as a turn that reads ten files.

**The literal trail, from `agent-ab977725ea58298d8`:**

```
 400  Bash    pnpm wp-finish-upsert-pr
 401  Bash    gh pr view 600 --json body,autoMergeRequest,mergeable ...
 402  Bash    gh pr checks 600 2>&1 | head -20
 403  Bash    until [ "$(gh pr checks 600 | grep -c pending)" -eq 0 ]; do sleep 20; done; ...
              run_in_background: True  ->  "Command running in background with ID: b7wphbixk.
                                            You will be notified when it completes."
 404  >>> 160 consecutive turns of `echo .`
```

The agent did the hard part right: it launched the wait **in the background**, and the harness told
it, in those words, that it would be notified. Then instead of ending its turn it **spun**:

| | |
|---|---|
| gap between consecutive `echo .` turns | **median 2.4s** (p90 3.2s) |
| duration of the `echo .` command itself | 1.2s — there is no `sleep` in it |
| tool result each time | `.` |
| context per turn at that point | 640k – 791k tokens |
| wall clock spent this way | **100 minutes** |
| streaks | 160, 144, 108, 97, 94, 42, 32, 23, 22 … |

**It is not polling every 20 seconds. It is spinning as fast as the API will answer** — a
three-quarter-million-token API call every 2.4 seconds, for 100 minutes, to print a full stop.

Two distinct waits produce it, both in this one run:

1. **Waiting on CI** after `wp-finish-upsert-pr` armed auto-merge — the three 160/144/108 streaks,
   each immediately after a backgrounded `until … gh pr checks` loop.
2. **Waiting on its own spawned subagents** — the 94- and 97-turn streaks come immediately after a
   burst of `Agent` spawns (the reviewers).

### 11c. What `Monitor` would have replaced

`Monitor` blocks on a condition **inside one tool call**. One call, one result, one turn — whatever
the wait costs in wall clock. The agent had it available and used it **once in 1,331 turns**.

| | turns | tokens |
|---|---|---|
| what happened: 160 × `echo .` at ~700k context | 160 | **~112M** |
| `Monitor` with the same until-condition | 1 | ~0.7M |
| simply ending the turn and waiting for the background notification | 0 | 0 |

The second row is the harness's own documented answer: *"`run_in_background` runs the command
detached — it keeps running across turns and re-invokes you when it exits. Foreground `sleep` is
blocked; use `Monitor` with an until-loop to wait on a condition."* The agent read half of that and
ignored the other half.

### 11d. The two runs, named

Both are `/full-cycle` workers in **`ctoteachings/monorepo1`**, spawned with their own worktrees:

| agent | description | when (UTC) | no-op turns | cost |
|---|---|---|---|---|
| `ab977725ea58298d8` | **"Catalogue: playable, paged, bylines"** — PR #600, `Fixes #587`, branch `dean/587-stories-catalogue` | 2026-09-06 13:31 → 16:20 | 666 of 1,331 | **465M** |
| `a491bca2b7168ee4f` | **"Full-cycle URL purity fix"** | 2026-09-04 21:20 → 22:11 | 356 of 594 | **128M** |

Both reached the end of their feature, armed auto-merge, and then burned the majority of their
total cost watching CI. **The waste is entirely in the tail, after the work was done.**

### 11e. Revised recommendation order

1. **Guard the no-op spin.** Deny `echo .` / `echo ..` / `true` / `:` as a whole command; cure text
   names `Monitor` and "or end your turn — a backgrounded command re-invokes you". Mechanical,
   ~4.4% of tokens, and it removes the tail risk of one unattended agent costing 5% of a week.
2. **Give subagents the low-water compaction Dean already does by hand.** He compacts at
   174k–466k; subagents get nothing until 1M. Closing that gap is the 20–61% lever, and §10's
   model is the estimate — an upper bound, because compaction can cost re-done work.
3. **Reviewer verdict cache** — 5.6%, clean, unrelated to either of the above.

---

## 12. Cost per PR, summed across every agent that worked the branch

**Method.** For each PR, its branch name was searched across every transcript on disk (main +
subagent) modified since 2026-08-28. A **subagent** run that mentions the branch is attributed
wholly to it — a subagent is spawned for one task. A **main** session is attributed only for the
turns between its first and last mention, because one main session drives several branches in a
day. This audit's own session is excluded: it greps branch names, so it matches everything.

The branch is the join key that makes this possible, and it is recoverable three ways —
`.webpieces/pr-review/<branch-slug>/` (which also carries `sessionId` and `mainTranscript`),
`.webpieces/worktrees/<agent-id>/`, and the branch string in the transcripts themselves.

### Every PR in the repo with >10,000 added AND >9,000 deleted

Four match, not two. All in `ctoteachings/monorepo`:

| PR | title | +/− lines | files | **tokens** | est $ | transcripts | tok/line |
|---|---|---|---|---|---|---|---|
| [#530](https://github.com/ctoteachings/monorepo/pull/530) | Generate a story into a playlist at a chosen level | +31,427 / −25,463 | 48 | **324.6M** | 535 | 8 (7 sub) | **6k** |
| [#462](https://github.com/ctoteachings/monorepo/pull/462) | Put the learning language in the URL | +27,343 / −18,294 | 61 | **295.6M** | 566 | 11 (10 sub) | **6k** |
| [#557](https://github.com/ctoteachings/monorepo/pull/557) | Make component → service → api structural | +18,039 / −10,563 | 203 | **708.3M** | 1,363 | 22 (20 sub) | 25k |
| [#554](https://github.com/ctoteachings/monorepo/pull/554) | One local store, one engine: IndexedDB on all three | +11,134 / −9,770 | 116 | **689.9M** | 1,154 | 9 (8 sub) | 33k |

**#557 + #554 combined = 1,398M tokens (~$2,517 est.).**

### Against the two runs from §11

| PR | +/− lines | tokens | tok/line |
|---|---|---|---|
| [#600](https://github.com/ctoteachings/monorepo/pull/600) *(the 666-`echo .` run)* | +3,475 / −1,083 | **864.8M** | **190k** |
| [#529](https://github.com/ctoteachings/monorepo/pull/529) *(the 356-`echo .` run)* | +1,366 / −13 | **202.7M** | **147k** |

**This is the comparison worth staring at.**

- **#530 changed 56,890 lines for 324.6M tokens. #600 changed 4,558 lines for 864.8M tokens.**
  #600 cost **2.7x more** for **one twelfth** the diff — **32x worse per line changed**.
- The two "huge" PRs Dean asked about (#557 + #554, 49,506 lines between them) cost 1,398M — only
  **1.6x** what the small #600 cost alone.

`tok/line` is a blunt instrument — a mechanical rename is cheap per line and a subtle bug is not —
which is exactly why the 32x gap is informative. #600 is not a harder problem than #530 by any
reading; the difference is that #600 spent 465M of its 865M spinning on `echo .` (§11b) and #530
did not.

### Shape of each PR's fan-out

| PR | biggest single agent | its share |
|---|---|---|
| #600 | `agent-ab977725ea58298d8` — *Catalogue: playable, paged, bylines* | 767M of 865M — **89%** |
| #554 | `agent-aec07b549754cfb76` — *Full-cycle unified local store* | 546M of 690M — **79%** |
| #530 | `agent-ae458b49923c28254` — *Full-cycle generate-story feature* | 298M of 325M — 92% |
| #462 | `agent-a57ff5f08e4becac5` — *Language in the URL + offline pattern* | 244M of 296M — 82% |
| #529 | `agent-a491bca2b7168ee4f` — *Full-cycle URL purity fix* | 186M of 203M — 92% |
| #557 | main session `d376786c` (attributed window) | 188M of 708M — 27% |

**#557 is the one structurally different PR here, and it is the cheaper pattern.** Instead of one
agent carrying the whole feature, it fanned out to **ten parallel workers** — *"Agent 1 wire
rules"*, *"Agent 3 rule 8 observables"*, … *"Agent 10 gate and land"* — each 8M–122M. Ten agents at
a few tens of millions each, on the largest file count in the repo (203 files), came to 708M with
no single run above 122M.

That matters for the §10 compaction argument: **short-lived parallel agents never accumulate the
context that makes a long agent expensive.** #557 got the effect of checkpointing for free, by
construction, because each worker started fresh and exited. It is the same lever from the other
end, and it needs no harness change at all.

### Reviewer cost on these PRs, for scale

Reviewer subagents on #600: 13 runs totalling ~78M — **9% of that PR's cost**, against the single
worker's 767M. On #554: 6 reviewer runs, ~47M — **7%**. On #557: ~15M — **2%**. This is the §2
finding restated per PR: the checklist is not what these PRs cost.

---

## 13. Why a PR costs what it costs — the whole equation in one table

Yes: **`tok/line` = total tokens ÷ (additions + deletions)**, so it is per line *modified*, not per
line of finished code.

The decomposition below is the answer to "what is costing us so much to write code", and it is
simpler than expected. Every number is summed over every agent, subagent and attributed main-session
turn on that branch.

| PR | link | tokens | turns | **tok/turn** | **lines/turn** | tok/line | no-op share |
|---|---|---|---|---|---|---|---|
| #530 | https://github.com/ctoteachings/monorepo/pull/530 | 324.6M | 961 | 338k | **59.2** | **6k** | 0% |
| #462 | https://github.com/ctoteachings/monorepo/pull/462 | 295.6M | 933 | 317k | **48.9** | **6k** | 0% |
| #557 | https://github.com/ctoteachings/monorepo/pull/557 | 708.3M | 3,183 | **223k** | 9.0 | 25k | 0% |
| #554 | https://github.com/ctoteachings/monorepo/pull/554 | 689.9M | 1,473 | 468k | 14.2 | 33k | 0% |
| #600 | https://github.com/ctoteachings/monorepo/pull/600 | 864.8M | 1,921 | 450k | **2.4** | **190k** | **54%** |
| #529 | https://github.com/ctoteachings/monorepo/pull/529 | 202.7M | 700 | 290k | **2.0** | **147k** | **63%** |

**The equation is `tok/line = (tok/turn) ÷ (lines/turn)`.** Check it: #530 is 338k ÷ 59.2 = 5.7k.
#600 is 450k ÷ 2.4 = 187k. Two factors, and only two.

### Factor 1 — the price of a turn barely varies

**223k to 468k across all six PRs.** A turn costs what the agent's conversation has grown to, and
nothing else. It does not matter whether the turn wrote 200 lines or printed a full stop. That is
the single most important fact in this whole audit.

### Factor 2 — lines produced per turn varies 30x, and THAT is the cost

| | lines/turn | what the turns were doing |
|---|---|---|
| #530, #462 | **49–59** | large coherent edits — new files written whole, a mechanical pattern applied across a tree. `Write` is 3–7% of tokens and Bash 59–80%. |
| #554, #557 | 9–14 | real refactors: edit, build, read the failure, edit again |
| #600, #529 | **2.0–2.4** | over half the turns produced **zero** lines — they were `echo .` |

**So "writing code" is not what is expensive. Turns that produce little or no code are.**

---

## 14. #600 specifically — what happened, and can it be fixed

**The work:** [issue #587](https://github.com/ctoteachings/monorepo/issues/587) *"/stories should be
the real shared catalogue: playable, paged, sorted, with author bylines"* →
[PR #600](https://github.com/ctoteachings/monorepo/pull/600), merged 2026-09-06 16:15:30Z, 62 files,
+3,475/−1,083.

**What went wrong** — one agent, `agent-ab977725ea58298d8`, 1,331 turns:

```
403  Bash  until [ "$(gh pr checks 600 | grep -c pending)" -eq 0 ]; do sleep 20; done; ...
           run_in_background: True
           -> "Command running in background with ID: b7wphbixk.
               You will be notified when it completes."
404  >>> 160 consecutive turns of `echo .`
```

It launched the CI wait **correctly, in the background**, and the harness told it in those words
that it would be re-invoked when the job finished. Then, instead of ending its turn, it **spun**:
`echo .` every **2.4 seconds median** (the command has no `sleep` in it — it returns in 1.2s), for
**100 minutes of wall clock**, at 640k–791k tokens per call, to print a full stop.

**668 of its 1,921 attributed turns were that. 465.9M tokens — 54% of the entire PR.**

Streaks: 160, 144, 108, 97, 94, 42, 32, 23, 22 … Three of them follow a backgrounded
`until … gh pr checks` (waiting on CI); two follow a burst of `Agent` spawns (waiting on its own
reviewers). `Monitor` — the tool built for exactly this — was called **once in 1,331 turns**.

**#600 also had the worst gate churn of any PR here:** `wp-review-upsert-pr` **×10**,
`wp-start-upsert-pr` ×6, `wp-finish-upsert-pr` ×5.

**Can it be fixed? Yes, and cheaply.** A PreToolUse guard denying `echo .` / `echo ..` / `true` /
`:` as an entire command, whose cure reads *"a backgrounded command re-invokes you when it exits —
end your turn; or use `Monitor` with an until-condition"*. Effect on #600:

| | tokens | tok/line |
|---|---|---|
| as it ran | 864.8M | 190k |
| with the no-op turns removed | **399M** | **87k** |

That single guard would have made #600 **2.2x cheaper**. It still would not reach #530's 6k/line —
the rest of the gap is factor 2, and that is about the work.

---

## 15. Why #530 and #462 are so much better — and what it means for your fan-out idea

### The honest answer on #530 / #462

They are cheap because of **lines per turn (49–59)**, not because of how they were organised. Both
were run by **one big agent doing 82–92% of the work** — the same shape as #600 and #554:

| PR | biggest agent | share | turns |
|---|---|---|---|
| #530 | `agent-ae458b49923c28254` *Full-cycle generate-story feature* | 92% | 754 |
| #462 | `agent-a57ff5f08e4becac5` *Language in the URL + offline pattern* | 82% | 534 |

So the thing that made them good is **not** staging. It is that their work came out in large
coherent chunks — files written whole, one pattern applied across a tree — so a turn's fixed price
was amortised over ~50 lines instead of ~2.

### Your fan-out hypothesis: half right, and the data says which half

> *"much of my cost is having ONE agent work on the whole plan instead of having a plan broken into
> stages and spinning up agents to work on each stage"*

**Test case: #557 is exactly that experiment.** It fanned out to **20 subagents** — *"Agent 1 wire
rules"*, *"Agent 3 rule 8 observables"*, … *"Agent 10 gate and land"*, largest 121.8M / 456 turns.

| | #530 (one agent) | #557 (fanned out to 20) |
|---|---|---|
| **tok/turn** | 338k | **223k — 34% cheaper** ✅ |
| turns | 961 | **3,183 — 3.3x more** ❌ |
| lines/turn | 59.2 | 9.0 |
| **tok/line** | **6k** | **25k — 4x WORSE** ❌ |

**Fan-out did exactly what you'd expect on the factor it controls** — short agents never accumulate
context, so the price of a turn dropped 34%, and no single run exceeded 122M. That is real, and it
is the same lever as compaction (§10) arrived at from the other end, with no harness change needed.

**But it did not make the PR cheaper**, because it needed 3.3x the turns. Coordination has a cost:
each stage agent re-reads the code the previous one wrote, re-establishes context, re-runs builds.
Ten agents each doing 300 turns beats one agent doing 1,331 turns on *price per turn* and loses on
*turns*.

**So the rule to take away is not "fan out" — it is:**

> **A turn costs the same whatever it does, so minimise turns first and turn-price second.**

Fan-out is the right tool when one agent would otherwise run past ~400 turns (where context makes
every turn 500k+). It is the wrong tool for work that one agent could do in 500 coherent turns.
#557 was probably the right call for its shape — 203 files, ten independent rules — and it still
cost 4x per line, because 203 files of fiddly per-file edits is inherently ~9 lines/turn work.

### Ranked, on this evidence

| lever | attacks | measured effect |
|---|---|---|
| **1. Kill no-op spin turns** | turns | #600 −54%, #529 −63%, fleet −4.4%. Mechanical guard. |
| **2. Compaction / short agents** | tok/turn | 223k vs 468k measured (#557 vs #554) — up to 50% of that factor |
| **3. Bigger coherent edits** | lines/turn | the 30x factor, and the least controllable — it is a property of the work |
| 4. Reviewer verdict cache | turns | 5.6% fleet; on #600, reviewers were 9% of the PR |

Note what is NOT on this list: writing code. Across all six PRs `Edit` + `Write` together are
**1–16%** of tokens. `Bash` is **37–81%**. The cost is in the loop around the edit — build, check,
read output, wait — not the edit.

---

## 16. Three corrections, from the guard logs and the gate's own output

### 16a. The exact no-op commands — and it is NOT one case, it is 10.7% of the fleet

From `.webpieces/worktrees/agent-ab977725ea58298d8/logs/L2-decisions/*.log`, the exact literal, as
the guard judged it:

```
2403  echo .          <- 60% of the 4,023 Bash rows judged in that one worktree
  20  pnpm wp-finish-upsert-pr
  18  git diff cb1a2e37 e7eeb850 -- services/angular/...
  15  pnpm wp-review-upsert-pr
  12  until [ "$(gh pr checks 600 2>&1 | grep -c pending)" -eq 0 ]; do sleep 20; done; gh pr checks 600 2>&1
```

**But `echo .` is only the local dialect.** Across every repo's L2 decision logs the waiting
vocabulary is much wider, and my "4.4%, two runs, may never recur" was measured on too narrow a
pattern. Re-measured over the window, main + subagent transcripts:

| category | turns | tokens | **share of fleet** |
|---|---|---|---|
| no-op turns | 3,938 | 1,607M | **8.6%** |
| hand-rolled `gh pr checks` polling | 1,069 | 382M | **2.1%** |
| bare `sleep` (the *correct* idiom — one turn per wait) | 8 | 2M | 0.0% |
| **ALL WAITING** | **5,015** | **1,990M** | **10.7%** |

Exact no-op commands, fleet-wide, by frequency:

```
1086  echo .          142  true              12  echo idle2
 384  echo idle        44  echo waiting      11  echo idle3
 339  echo ok         181  date -u +%H:%M     9  echo idle4 / idle5 …
```

`echo idle2`, `idle3`, `idle4`, `idle5`, `idle6` is the detail worth noticing: the agent is
*incrementing a counter in the string*. It knows it is spinning.

And it is spread, not concentrated: `monorepo1` 890M, `monorepo3` 538M, `monorepo2` 428M,
`monorepo-nx1` 37M, `monorepo-nx3` 34M, `webpieces-ts40` 24M, `monorepo-nx4` 14M, `monorepo-nx2` 9M
— **8 repos**. Worst runs: 466M, 206M, 195M, 129M, 121M, 102M, 74M, 61M, 58M, 49M — **ten runs over
49M each**, not two.

**So: 10.7% of the fleet, recurring across 8 repos and at least 10 agent runs in 4 days.** That is
the corrected number, and it is more than double what I first said.

### 16b. There WERE red verdicts — my "0 reds in 4 days" was wrong

The earlier count read `.webpieces/pr-review/<branch>/review-*.json` off disk. **Those files are
transient** — the branch directory is cleaned when the PR lands — so scanning survivors sees only
branches that happen still to exist. The durable record is the gate's stage-2 output, quoted
verbatim into the transcript.

Counted that way: **30 FAILED-review events across 7 checklists and 14 branches.**

| reviewer | reds | | reviewer | reds |
|---|---|---|---|---|
| angular-patterns-reviewer | 10 | | morpheus-wrapper-terraform-kami | 2 |
| backwards-compat-reviewer | 6 | | security-auth-reviewer | 1 |
| morpheus-wrapper-linear-required | 5 | | data-model-reviewer | 1 |
| error-handling-reviewer | 5 | | | |

Branches include `dean-587-stories-catalogue` (3 reds from angular-patterns),
`dean-connector-storyboard-screenshots` (4), `dean-849-hermetic-guard-presence-spec`,
`dean-claude-md-index`, `dean-issue-551-one-local-store`, and nine more.

**Dean's original description of the cycle was right and my report contradicted it.** Reviewers do
go red, the agent does fix and re-review. §3 of this report should be read with that correction.

### 16c. The reviewer cache ALREADY EXISTS, already works, and the AI is not freelancing

This is the biggest correction. The gate's stage-2 output does not blindly demand the whole
checklist. It carries verdict state per branch and holds reviewers back:

```
STEP 2 — only once that file is written, spawn these 4 REQUIRED reviewer subagent(s) …
         1 of them already ANSWERED and refused (marked ⛔ below). Do not spawn
         those against unchanged code — fix what they found first.

  ⛔ angular-patterns-reviewer — ALREADY REVIEWED THIS BRANCH AND REFUSED.
     It will refuse again on unchanged code.
```

and when everything has answered, stage 2 collapses to:

```
STEP 2 — only once that file exists, run:  pnpm wp-finish-upsert-pr
         (The build gate is already green for this commit — finish reuses it unless HEAD moves.)
```

Measured across every stage-2 output in the window:

| | |
|---|---|
| stage-2 outputs captured | **239** |
| of those, **asked for reviewers** | 146 |
| of those, **"no reviewers needed — go to finish"** | **87 (36%)** |
| reviewers the gate REQUESTED, in total | **386** |
| reviewer runs actually observed (§3) | **380** |
| already-refused reviewers explicitly held back | 30 |
| distribution of "spawn N reviewers" | N=1 ×51, N=2 ×38, N=3 ×16, N=4 ×13, N=5 ×12, N=6 ×14, N=7 ×1, N=8 ×1 |

**386 requested, 380 run.** The AI is doing exactly what the gate asks — no more. It is not
re-reviewing because it "thinks it has to"; there is nothing to message it not to do. And the most
common request is **one** reviewer, so the invalidation is already scoped, not all-or-nothing.

**So "add a reviewer verdict cache" — my §3 recommendation — was wrong: it is already built.** The
272 "repeat" runs I counted are mostly the gate correctly re-requesting a reviewer whose files
changed since it last answered, plus the 30 red→fix→re-review cycles.

**The real number to attack is 239 stage-2 runs for 28 PR cycles — 8.5 per PR.** Each one rebuilds
(§3: 230 `by=review` builds) and re-requests whatever the last commit invalidated. The question is
not "why does it re-review" but **"why does the gate run 8.5 times per PR"** — and on the evidence
of #600 (`wp-review-upsert-pr` ×10, `wp-start-upsert-pr` ×6) that is the agent looping through the
gate as it fixes reds and amends, which is the gate working as designed.

Residual saving from a smarter cache is therefore small. **Strike it from the lever list.**
