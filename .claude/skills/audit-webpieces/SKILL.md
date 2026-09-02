---
name: audit-webpieces
description: Audit AI correctness and speed across Dean's webpieces-governed repos (~/workspace/onetablet/monorepo-nx*, ~/workspace/ctoteachings/monorepo*, ~/workspace/personal/webpieces-ts*). Reads recent transcripts and .webpieces guard logs to find where the AI wasted time, where guards put it in block/cure cycles, where worktree and .webpieces isolation broke, where builds were re-run instead of read from build.log, where builds were killed and re-run or contended with each other in the machine-wide build ledger, where docs name paths that do not exist, and where @webpieces pins have skewed. Use when Dean types /audit-webpieces, or asks "where is the AI wasting time", "are the guards deadlocking", "audit the guard logs", "why is the agent slow". MAJOR issues only. Read-only except for the one report file.
---

# audit-webpieces

Find the few things actually costing AI correctness and speed across the webpieces repo fleet.
**Report only — never fix anything.** The single write is the report file.

## The one rule about volume

There are ~700 transcripts a week and single project directories exceed 200 MB. **Never read a
transcript, a guard log, or a build log directly.** Everything comes through the two collector
scripts, which emit aggregates. Reading raw logs into context is the failure this skill exists to
measure — do not commit it while measuring it.

Open transcripts only to quote one specific line you already located by session id.

## Step 1 — scope

If Dean named repos and a window, use them. **Otherwise ask** (AskUserQuestion) — do not assume:

- **Repos**: all three orgs / everything matching the globs · onetablet only · ctoteachings only ·
  personal/webpieces-ts only · the current repo
- **Window**: last 24h · last 72h · last 7 days · last 30 days

Expand globs to real git repos first so you can show Dean what "all" means:

```bash
ls -d ~/workspace/onetablet/monorepo-nx* ~/workspace/ctoteachings/monorepo* ~/workspace/personal/webpieces-ts*
```

## Step 2 — collect

`SK=<this skill's base directory>/scripts`, `OUT=<your scratchpad>`. The base directory is the one
named at the top of this skill — it lives in the REPO (`<repo>/.claude/skills/audit-webpieces`), not
under `~/.claude/skills`. Do not type a remembered path; use the one the skill header gave you.

```bash
python3 $SK/wp_audit.py all --repos <repo> [<repo>...] --hours <N> > $OUT/all.json
python3 $SK/digest.py $OUT/all.json > $OUT/digest.md
python3 $SK/builds_ledger.py --since <ISO-8601 UTC> [--until <ISO-8601 UTC>] \
        --repos <repo> [<repo>...] > $OUT/builds.json
```

Read `digest.md` (~15-25 KB). That is your working set. Go back to `all.json` with `jq`/python for a
specific number — never `cat` it.

Timing: ~3s per repo. `--no-npm` skips the one network call. `--max-sessions N` caps transcript scan.

Subcommands exist individually (`guards`, `isolation`, `transcripts`, `parity`, `skew`, `docdrift`,
`matrix`, `merges`) when Dean asks about one area only. `builds_ledger.py` is a separate script because its
source is the one piece of webpieces state that is NOT per-repo — see Step 2b.

## Step 2b — the machine-wide build ledger

`~/.webpieces/builds.log` (shipped in @webpieces **0.4.687**, `rules-config`'s `BuildsLog`) is an
append-only TSV record of every build this box has started. It is the ONE piece of webpieces state
that lives outside a repo, deliberately: "how much of this machine's CPU is being burned by builds
right now" is a property of the MACHINE, and a per-repo ledger cannot see it — every linked
worktree has its own `.webpieces/`, so it would be blind to the sibling worktree it is actually
contending with, never mind the other repos on the disk.

```
START         id=<uuid> t=<iso> ms=<epoch> by=<build|review|finish> repo=<path> tree=<name> \
              cwd=<path> branch=<b> pid=<n> wp=<version>
DONE-SUCCESS  id=<uuid> t=<iso> ms=<epoch> by=<caller> repo=<path> took=<ms> pid=<n>
DONE-FAIL     id=<uuid> t=<iso> ms=<epoch> by=<caller> repo=<path> took=<ms> exit=<n> pid=<n>
```

`t`/`ms` are **UTC** — convert Dean's local window before filtering. `by` is the CALLER: `build` is
an ad-hoc `pnpm wp-build`; `review` and `finish` are the gate's stages 2 and 3. The file **rotates
at 1 MB** into `builds.log.1` … `.5`, oldest dropped — an audit over a long window must read the
rotated generations too, **oldest first**. `builds_ledger.py` does that for you.

**Use `--since <ISO-8601 UTC>`, not `--hours`, for anything that goes in the report.** An hours
count is relative to when the command happened to run, so a committed report can never be
reproduced from it. Quote the exact UTC window in the report.

**For a CLOSED period — "Monday through Wednesday", "last week" — pass `--until` as well.** Without
it the window runs to *now*, so a Mon-Wed audit silently swallows Thursday and the report stops
matching its own scope line. Convert Dean's LOCAL days to UTC first; this box is not on UTC.

### Be honest about coverage

The ledger did not exist before 0.4.687 landed on this box — **2026-08-21T05:59:13Z is the earliest
row that will ever exist**. Any window starting before that has NO ledger data for its early part.
`builds_ledger.py` reports `ledger_earliest_row` and sets `window_starts_before_ledger` exactly so
you can say this out loud. **Silence in an uncovered period is not quiet — it is blindness**, and a
report that presents "0 concurrent builds" for a period the ledger could not see is worse than one
that says nothing. State the covered fraction of the window in the scope line.

### What to mine it for — MAJOR only

| Signal | What counts | Why it is MAJOR |
|---|---|---|
| **Wasted builds** | a `DONE-FAIL` with a SIGNAL exit — `exit=130` SIGINT (Ctrl-C, an agent watchdog, a closed terminal), `137` SIGKILL, `143` SIGTERM — followed by a near-identical re-run in the same repo+tree | the killed run produced **nothing**. Report the minutes burned and the total spent for ONE result. A build red because the code is red is not this — that build answered its question. |
| **Concurrency / contention** | STARTs whose `[start, start+took]` intervals overlap; report **max concurrent** and **total overlapped minutes** | this is the thing the ledger was built for. CLAUDE.md records **~3.2x** slower total test time under agent contention, with individual suites 3x slower than the same suite minutes later on an idle box. Overlap minutes is the direct measurement of a cost that used to be folklore. |
| **Orphaned builds** | a `START` with no `DONE-` row whose `pid` is **dead** (`kill -0` → ESRCH) | a build died without recording an outcome, so nobody — no agent, no gate — can tell whether it passed. A START with no DONE whose pid is **alive** is just a build running right now: report it separately, never as a finding. |
| **Repeat builds** | same `repo=`+`branch=` built ≥3 times inside an hour | the "re-ran the build to see a different slice of the output" antipattern CLAUDE.md names by measurement (23.9 minutes across nine builds, five with no code change between). The ledger cannot see whether a file changed in between, so this is a **candidate** list — confirm against the transcript collector's `redundant_builds` / file-edit history before calling it. |
| **Duration outliers** | `took=` far above the median for the same repo | a 3x-median build usually means contention (cross-check the overlap window) or a cold nx cache — say which, because the fixes are opposite. |
| **`wp=` version mix** | `by_version` — builds, minutes, fails and kills per governing release; `latest_in_window` and `pct_on_latest` | a finding produced under an older release may already be FIXED. Weight the latest; see "Attribute every finding to a release" below. |
| **`by=` breakdown** | share of `build` (ad-hoc) vs `review`/`finish` (gate) | three gate stages are meant to cost **one** build: stage 2 records the sha it verified and stage 3 skips its own build when HEAD has not moved. A high ad-hoc ratio means agents are building outside the gate and then making the gate build it again. |

Cross-check the ledger against the transcript collector rather than reading either alone: the
ledger knows exactly how long a build took and who else was running, and knows nothing about
whether the agent then READ the log. `top_log_files` and `redundant_builds` in `all.json` are the
other half.

## Step 2c — merge activity and per-agent time (optional, when the window warrants it)

Two further sources, both already covered by `wp_audit.py` but worth naming because they answer
"what was this agent doing between builds":

- **3-point merge activity** — `<repo>/.webpieces/merge-info/index.json` (which branches are staged
  vs finalized) and `<repo>/.webpieces/logs/branch-mutations.log` (the rename/update trail). The
  `merges` subcommand parses both. Note branch-mutation rows are thin: a `wpN`→`wpN+1` rename is
  recorded with no reason, so a mid-work conflict is not distinguishable from a routine update.
- **Per-agent time** — `<repo>/.webpieces/logs/L0-shim/`, `L1-location/`, `L2-decisions/` join to
  `~/.claude/projects/<sanitized-repo>/<sessionId>.jsonl` on session id (guard filenames are
  `<sessionId>-<callId>-guards.log`). That join is what turns a block count into "here is the
  session, and here is the 7 minutes it then spent". **Still never read a transcript wholesale** —
  the `transcripts` subcommand aggregates them; open one only to quote a line you already located.

## Step 3 — what the collectors measure

| Area | Signal | Where it comes from |
|---|---|---|
| Wasted time | active hours, blocked-call seconds, **builds with no intervening file edit**, repeated identical commands, tool histogram | Claude transcripts `~/.claude/projects/<sanitized-repo>/*.jsonl`; Codex rollouts `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` |
| Codex parity | per-surface `claude_hits` vs `codex_hits` across all five streams, and the whole-harness verdict. **A rule with Claude traffic and ZERO Codex traffic is a coverage hole** — the detector for a tool-name mapping we got wrong | all five guard streams' `ai=` field |
| Guard cycles | block rate, **consecutive blocks on one rule in one session**, **same cure prescribed ≥4×**, non-`-` fault codes | `<repo>/.webpieces/logs/L2-decisions/`, `rejections/` |
| Stale-main health | `stale_main_health` — per session: did `localMain=` ADVANCE (the block worked) or repeat (the cure is not taking), plus `kinds` splitting the blocks into prevented-a-stale-read / cure-bundled-with-`&&` / cure-bundled-with-`;` / off-repo, and `blocks_that_bought_nothing` | `L2-decisions/` `localMain=`/`originMain=` |
| Isolation | worktrees with no `logs/` of their own, **commands run inside a worktree judged with `root=` the primary tree**, L0 `shim=` vs L1 `root=` disagreement, build.log in two trees | `L0-shim/`, `L1-location/` |
| Version skew | pin vs installed per tree, worktree installs vs primary, npm latest | `pnpm-workspace.yaml`, `node_modules/@webpieces/nx-webpieces-rules` |
| Matrix conformance | logged `layer=`/`row=`/`fault=` vs the **normative** table in `webpieces.branch-state-matrix.md` (L2) and `webpieces.guard-matrix.md` (L0): decision disagrees with the row's `act`, row cited that the matrix does not define, undocumented fault code, layer that logs rows with no matrix table, rows never exercised | `.webpieces/instruct-ai/*.md` + guard logs |
| Build ledger | **killed-and-re-run builds**, **overlapping builds** (max concurrent, overlapped minutes), orphaned STARTs with a dead pid, repeat builds of one repo+branch, duration outliers, ad-hoc vs gate `by=` split | `~/.webpieces/builds.log` (+ rotated `.1`…`.5`) — MACHINE-wide, not per repo |
| 3-point merges | branches re-merged 3+ times, merges staged in `index.json` but never finalized, CONFLICT with no later FINALIZE, conflict files, orphan `staged/` dirs | `.webpieces/merge-info/index.json`, `logs/branch-mutations.log` |
| Doc drift | paths quoted in CLAUDE.md / `.webpieces/instruct-ai/*.md` / `.claude/**/*.md` / user skills that **do not exist**, with a dedicated `build.log` path check | filesystem |

### The two harnesses

Every guard row carries a trailing `ai=` field, so every metric above has a per-harness twin
(`guards.by_ai`, `transcripts.totals_by_harness`) and `digest.py` prints the two side by side.
Four things to hold on to:

- The values are the `AiType` union's own strings: **`claude-code` and `codex`**, never `claude`.
- A row with no `ai=` predates the field and reads as **`unknown`** — a real value, not a gap. Do
  not fold it into either harness.
- **Thresholds are applied PER HARNESS, against that harness's own denominator.** A harness under
  `MIN_DECISIONS_FOR_RATE` is marked `low_sample` and gets no verdict, so a young Codex sample is
  never reported as a regression.
- **Codex sessions with ZERO guard rows is the finding to look for**, not zero blocks. Codex
  transcripts are flat by date with no per-project directory, so they are selected by
  `session_meta.payload.cwd`; sessions present in `~/.codex/sessions` for a repo whose guard logs
  show no `ai=codex` rows means the hooks never ran — the one-keystroke "Continue without trusting
  (hooks won't run)" path, or a matcher that matches nothing. It looks exactly like peace and quiet
  in every total.

Guard logs and transcripts **join on session id** — guard log filenames are
`<sessionId>-<callId>-guards.log`, and the transcript is `<sessionId>.jsonl`. Use that to turn "76
blocks on stale-main-bash-guard" into "here is the session, here is what the agent did next."

## Step 4 — judge, do not dump

The collectors find candidates. You decide what is MAJOR. A finding earns a place only if it
**cost real time or produced a wrong result**, and you can say which.

Rank by cost and lead with it. Drop anything you cannot attach a number or a concrete failure to.
Ten findings is too many; three real ones is a good audit.

Interpretation that matters:

- **Attribute every finding to a RELEASE, and weight the latest one.** This is the first filter, not
  a footnote: webpieces ships often, and a defect measured under a release that has since been
  superseded is history. Two sources give you the attribution — `by_version` in `builds.json` (every
  `START` row carries `wp=<version>`, so a build finding is attributable exactly), and the version
  header `digest.py` prints (npm latest, plus each repo's installed / pinned / per-worktree
  versions), which is how a guard or transcript finding — those carry no version of their own —
  gets attributed via the repo it came from. State the version beside every finding. When a finding
  appears ONLY on a release that is no longer installed anywhere, say so and rank it below the
  live ones rather than dropping it silently. When `pct_on_latest` is low, say that too: it means
  the window is mostly measuring old code and the whole audit is weaker evidence about today.
- **`stale-main-bash-guard` is judged by whether the tree got FRESH, never by its block count.** It
  is reliably the loudest rule in the logs, and the count on its own means nothing — a block that
  stops an agent reading fifteen-commit-stale source is a **speed win**: one round trip spent, a
  wrong answer and everything built on top of it saved. **Correctness is how this guard buys speed**,
  so a high count is evidence it is working until you show otherwise. Read `stale_main_health` BEFORE
  `blocks_by_rule`, and split the blocks four ways:

  | `kinds` bucket | verdict |
  |---|---|
  | `prevented_stale_read` | the guard EARNING its keep. Goes in "checked and clean", never in a cost finding. |
  | `cure_bundled_semicolon` | `<cure>; <work>` — the work runs even if the pull failed, and agents usually `>/dev/null 2>&1` the cure so the failure is invisible. Refusing is right: the two-step IS safer, because the next call is a fresh evaluation that recomputes `localMain` vs `originMain`, so a failed pull re-blocks — an allowed compound never gets that second look. A high count is a finding about the **AGENT**. |
  | `cure_bundled_and` | `<cure> && <work>` — the shell already guarantees the work is skipped if the cure fails, which is exactly the property the guard needs. **Blocking this is a TOOLING finding**: a round trip spent for nothing. |
  | `blocked_badly` | target is outside the repo — a scratchpad file, a skill file, `curl localhost`, `ps -p`. Nothing there can be stale. Also a tooling finding. |

  Then read the verdict, which is computed from the state chain, not from counts:
  **`healthy`** — a later block's `localMain` equals an earlier block's `originMain`, so the agent
  pulled, the tree genuinely moved forward, and origin simply moved again. That is the guard working
  and it is cheap; do not report it as cost. **`cure-not-taking`** — the same `(localMain,
  originMain)` pair repeats with no advance. *That* is the real deadlock, it is rare, and it is the
  only shape here that earns a MAJOR. Quote the repeated pair as the evidence.

  The number to report as cost is `blocks_that_bought_nothing` (`cure_bundled_and` + `blocked_badly`),
  never the raw block count.
- **Contention is measurable now — stop guessing at it.** Before the ledger, "agents slowed each
  other down" was folklore backed by one hand-timed comparison. `overlapped_minutes` and
  `max_concurrent` are the real number, and a window with zero overlap is a genuine finding in the
  other direction: it means the slowness has some other cause, and CPU contention is off the list.
- **A killed build is worse than a failed one.** A red build answered its question. A build killed
  by SIGINT/SIGKILL answered nothing and its entire `took=` is burned — count it whole, and add
  the re-run's time to it to state what one result actually cost.
- **Redundant builds are the headline metric.** A build re-run with no edit between cannot return a
  different answer — it is the agent re-running to see a different slice of output. Cross-check
  against `top_log_files`: did it read the log at all?
- **A cure prescribed 19 times is a broken cure**, not a stubborn agent. Quote the cure text and say
  why the state it names was not resolvable by it.
- **`root=` pointing at the primary tree for a command whose cwd is a worktree** means the branch
  verdict describes the wrong tree. That is a correctness bug, not a slowdown.
- **A doc naming an absent path** — especially a `build.log` path — makes the agent read nothing,
  conclude the step failed, and redo the work. Highest-leverage class of fix.
- Distinguish **guards working as intended** (a block that stopped a real mistake, once) from
  **guards costing time** (the same block N times with no progress between). Only the second is a
  finding. Say so explicitly when a high block count is the guard doing its job.
- **A block COUNT is never a finding until the blocks are CLASSIFIED.** Counting alone gets the sign
  wrong, not just the size. Written from a live miss: an audit led with `stale-main-bash-guard` as a
  tooling defect on a count plus one quoted log line; classifying all 44 blocks in that session
  inverted the conclusion — most of them were the guard correctly refusing a wrong answer, or
  refusing the agent's attempt to smuggle one past it. **The default assumption is that the guard is
  right and the AGENT is the defect**, and it takes evidence to move off it. In particular a `cure=`
  repeated N times means the STATE kept recurring, not that the cure failed: prove it by checking
  whether the state actually advanced (`localMain=` chaining forward) before ever calling a cure
  broken.
- **Matrix mismatches are correctness bugs, not slowdowns.** The matrices are what an agent reasons
  from; if the log says row 5 and the matrix says row 5 allows what was blocked, either the guard is
  misrouting or the doc is stale. Say which you think it is. Note `PASS` and `allow` are the same
  verdict spelled differently across layers, and that these docs contain SEVERAL numbered tables —
  only the one with an `act` column is normative. Do not report a row-number collision as drift.
- **A `staged/` directory is not a stuck merge** unless `index.json` still tracks it as staged;
  otherwise it is finished-merge litter. `CONFLICT` rows carry no `branch=`, so judge resolution
  chronologically, not per branch. Two 3-point rounds on a long-lived branch is normal — three is churn.
- A block count with **no** matching transcript stall is usually the guard catching a subagent
  cheaply. Check before calling it MAJOR.

## Step 5 — report

Write to the **webpieces repo you were invoked from** (default `~/workspace/personal/webpieces-ts30`):

```
<repo>/docs/audit/<YYYY-MM-DD>-<window>.md      e.g. docs/audit/2026-08-20-7d.md
```

**Write it to your scratchpad FIRST, then `cp` it into the repo.** The report is untracked, and a
`wp-review-upsert-pr` run — including one from ANOTHER session working the same tree — squashes,
amends and resets, deleting untracked files with nothing archived to `.webpieces/trash/`. That
destroyed the first report this skill ever produced, 36 minutes after it was written. Keeping the
scratchpad copy makes the repo file replaceable, and tell Dean it needs committing to survive.

Then open it for review:

```bash
webstorm <absolute path to the report>
```

Structure:

1. **Scope line** — repos, window (**as an absolute UTC range**, not "last N hours"), sessions
   scanned, guard decisions scanned, builds in the ledger — and, when the window starts before
   `ledger_earliest_row`, the fraction of it the ledger actually covers.
2. **Versions audited** — a short table: npm latest, and per repo the installed / pinned version
   (flagging any worktree that disagrees), plus the `by_version` build mix with `pct_on_latest`.
   This table is what makes the rest of the report readable a release later: without it nobody can
   tell whether a finding still applies. Every finding in §3 names the release it was measured on.
3. **Top findings, ranked by cost**, each: what · measured cost · evidence (repo, session id,
   rule, counts, one quoted line) · why it costs · suggested direction (a sentence — you are not
   fixing it).
4. **Numbers table** — active hours, blocked minutes, builds vs redundant builds, block rate per repo.
5. **Checked and clean** — one line per area with nothing MAJOR, so a clean area is visibly clean
   rather than silently absent.

Finish by telling Dean the path and the single most expensive finding in one sentence.

## Hard limits

- **Read-only.** The report file is the only write. Never edit a doc, config, guard rule, or repo,
  and never run `pnpm install`, a build, or any `wp-*` command — those mutate state and this is an
  observation tool. If a fix is obvious, put it in the report as a suggestion.
- These repos include **client work** (onetablet, ctoteachings). Reading their logs for this audit is
  fine; do not copy their source, ticket contents, or business detail into the report. Reference
  sessions by id.
- If a guard blocks the report write (e.g. the repo is on `main`), do **not** fight it — write the
  report to the scratchpad, open that instead, and note the block in your summary. It is itself a
  data point for the audit.
