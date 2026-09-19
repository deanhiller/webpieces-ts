# Audit 2026-09-13 — reviewers OFF (Wed–Fri) vs ON (Sat–Sun)

Artifact: https://claude.ai/code/artifact/5e19b5f3-4d14-4b80-84ce-8e6aed8ab6c6

## Scope
- Weekday: 2026-09-08T21:00Z → 2026-09-11T21:00Z (Wed–Fri EEST, 3.0 days). Weekend: 2026-09-11T21:00Z → 2026-09-13T19:30Z (1.94 days).
- 16 repos (onetablet monorepo-nx1–4, ctoteachings monorepo*, personal webpieces-ts*). Build ledger fully covers both windows (earliest row 2026-08-21).
- `~/.webpieces/config.json` `turnOffAllReviewers:false`, mtime 2026-09-11T14:37Z (Fri afternoon, so Friday evening is partly "on").
- Tokens: an independent re-count over every Claude transcript + subagent + Codex rollout, deduped by `message.id` / `response_id`, split by local day × org × role (main / reviewer / other sub-agent / Codex guardian). Lines: merged PRs by Dean (gh for ctoteachings + webpieces-ts; `git log origin/main` numstat for monorepo-nx, which gh cannot read), excluding generated files. onetablet #1219 (113k-line vendored port) excluded.
- Before collecting, I fast-forwarded webpieces-ts50 `main` and ran `pnpm install` (0.4.748 → 0.4.761). stale-main-bash-guard and version-drift blocked every command until I did.

## Versions
npm latest 0.4.763. ctoteachings 0.4.759–0.4.763; monorepo-nx 0.4.755 (nx1 pinned 0.4.759 but has 0.4.755 installed; nx2/nx3 agent worktrees on 0.4.700–0.4.749); webpieces-ts 0.4.761. Ledger builds on the latest release: 2% weekday, 7% weekend.

## Phase breakdown (ctoteachings; per-thread attribution, weekend runs to Sun 21:00Z)

Each Claude session/sub-agent and Codex rollout is split at its own wp-start-upsert-pr / wp-review-upsert-pr / wp-finish-upsert-pr / wp-land-pr calls. Reviewers are charged to the gate. Explorers and Codex guardian approval checks inherit their parent's phase.

| Phase | Wed–Fri tokens | share | Sat–Sun tokens | share | worker active h wk→we | reviewer h | est $ wk→we |
|---|---|---|---|---|---|---|---|
| implement | 796M | 49% | 1,076M | 27% | 30.4 → 26.4 | — | $176 → $1,048 |
| merge (start→review) | 41M | 3% | 269M | 7% | 1.2 → 6.3 | — | $9 → $91 |
| **gate (review→finish)** | 339M | 21% | **1,783M** | **45%** | 8.5 → 39.1 | 2.1 → 20.4 | $66 → $878 |
| finish→land | 148M | 9% | 143M | 4% | 7.4 → 3.8 | — | $34 → $88 |
| after land | 209M | 13% | 303M | 8% | 10.8 → 8.5 | — | $43 → $278 |
| unphased (coordinators) | 84M | 5% | 371M | 9% | 6.7 → 23.1 | — | $15 → $592 |

- Gate split, weekend: workers (fix loops, gate re-runs) 953M, reviewers 701M, Codex approval checks 129M. wp-review-upsert-pr calls per PR thread 3.8 → 5.9. Coordinators spent 0.9h → 15.4h waiting on sub-agents. The gate build itself took 2.2h.
- Merge churn: wp-start-upsert-pr calls per thread 1.8 → 3.0; threads that re-merged 39% → 61%; CONFLICT merges 8 → 22; merge tokens 41M → 269M. Longer gates leave PRs open while main moves (27 PRs landed Saturday), so the merges repeat.
- Contention is **not** the cause. Weekend ctoteachings gate builds: 166 ran alone (median 1.02 min), 58 with two running (1.10 min), 15 with three (2.30 min). Weekday had the same shape.
- Unphased Claude coordinators cost $592 on the weekend (263M Claude tokens), all dispatch and watching.

### Would stopping re-review help? (weekend ctoteachings gate; 219 of 268 reviewer runs tied to a PR thread)
| Bucket | Runs | Tokens | Est $ |
|---|---|---|---|
| First review of each checklist | 116 | 387M | $80 |
| Re-run green → still green | 23 | 55M | $13 |
| Re-run red → green (confirms fix) | 24 | 83M | $16 |
| Re-run still red | 7 | 23M | $4 |
| Re-run green → NEW red | 7 | 18M | $3 |
| Workers + approval checks before any reviewer ran (gate build/merge loops) | — | 367M | $270 |
| Workers while a red was open (fixing) | — | 178M | $36 |
| Workers while reviews ran / after they passed | — | 533M | $118 |

All re-reviews together are 184M tokens / $37 (~5% of weekend ctoteachings tokens). Stopping them would ship 7 incomplete fixes and miss 7 new reds. The big levers are the pre-review gate loops (18 of 48 threads ran wp-review-upsert-pr ≥6 times) and worker burn while reviews run.

## Tokens per line changed

| Org · window | PRs | Hand lines | Tokens | Tok/line | Fresh/line | Reviewer tok | Est $ | $/100 lines |
|---|---|---|---|---|---|---|---|---|
| ctoteachings Wed–Fri | 37 | 43,334 | 1,619M | 37,369 | 1,981 | 74M (4.6%) | $346 | $0.80 |
| ctoteachings Sat–Sun | 47 | 53,487 | 3,731M | 69,752 (+87%) | 2,568 (+30%) | 669M (17.9%) | $2,803 | $5.24 |
| onetablet Wed–Fri | 38 | 36,648 | 1,579M | 43,083 | 1,240 | 4M | $3,203 | $8.74 |
| webpieces Wed–Fri | 11 | 6,779 | 210M | 31,014 | 1,065 | 0 | $142 | $2.09 |
| webpieces Sat–Sun | 4 | 8,921 | 207M | 23,250 | 799 | 55M (26%) | $41 | $0.46 |

Est $ is list-price weighting (Claude at Opus rates, Codex at GPT-5 rates), not a bill. Cache-read share is ~96%.

## Top findings (ranked by cost)

1. **The ctoteachings cost jump comes from the Claude harness, not from reviewers** (0.4.759–763). Claude tokens in ctoteachings went 8M → 1,133M and est $17 → $2,308, which is $2,291 of the $2,457 increase. Claude general-purpose workers alone were $1,270. All reviewers together added $413. Direction: run full-cycle workers and reviewers on Codex for ctoteachings.
2. **Reviewer fan-out loops cost time and tokens** (0.4.759–763). 237 weekend reviewer runs (Codex 191, Claude 46): 163 green, 29 yellow, 41 red. 17 of 42 PR units went red, followed by 33 re-reviews. 25 units never went red but still used 99 runs / 297M tokens. full_cycle_816 (codex parent 01a09b3b) ran 27 reviews with 11 reds (67M tokens). Gate builds per ctoteachings PR went 2.8 → 5.1. Review→finish blocking per cycle went 2.4 → 13.5 min (p95 7.6 → 20.0). Roughly 20 of the 41 reds are real behaviour bugs caught BEFORE merge (e.g. the setup deep-link bug: red at 10:01Z on #779, fixed, green at 10:11Z; those setup URLs work in production because of it) (races, wrong navigation, silent success, auth gaps); ~17 are convention, missing tests, or stale docs. That is ~$21 per real defect caught. A Claude reviewer run averages $6.80 vs Codex $0.65. Direction: after a red, re-run only the reviewer that went red; skip the fan-out on small PRs.
3. **27% of ctoteachings gate builds are killed with SIGINT** (exit=130). Weekday 28/103 (44 min); weekend 66/241 (118 min). The rate is identical with reviewers off and on, so the cause is likely Codex's exec timeout, not reviewers. Max concurrency was 3, so contention is ruled out.
4. **Stuck agents.** Three Codex reviewer sub-agents stayed alive 437–554 min for a ~4-min job (issue #858 idle stall). Weekday, 4 stale-main "cure-not-taking" sessions (monorepo3 codex 01a08cbd: 26 blocks, 19 identical states). Weekend had none, just 4 short streaks.
5. **The audit collector miscounts tokens.** `_scan_session` sums usage on every assistant row, but one Claude API call spans several rows (221 rows / 111 message ids in a sample), so Claude tokens are roughly doubled. Codex sub-agents (reviewers, guardian) are all filed as main-agent. `--max-sessions 400` truncated the weekend. Fix: dedupe by id, classify `session_meta.agent_role` / `source.subagent`, raise the cap.

## Time breakdown (cycletime; reconciliation PASS both windows)
AI 49.8% → 56.3%, HUMAN 46.9% → 38.1%, LOCAL_BUILD 1.1% → 2.8%, asleep 1.1% → 2.2%, CI 0.5% → 0.3% (75% coverage, since gh cannot read monorepo-nx). The REVIEWER bucket reads ~0h because Codex reviewer time falls into the AI residual, so the AI share is an upper bound. Branch→land blocking p50: 9.6 min (n=44) → 8.4 min (n=19).

## Monitoring (token burn, #874)
Waiting tokens: 18.3% (09-07) → 0.16% weekday → 0.02% weekend. wp-await adoption 35/46 → 12/13. Fixed. Stale tracking: issues #878 and #881 are still open (superseded by #900/#902). monorepo-nx3 tasks.md still tracks the closed #900. monorepo-nx1 tasks.md says turnOffAllReviewers is ON, but it has been false since Fri. The task lists were read, not refreshed. Codex guardian approval checks are 5–7% of tokens every day.

## Checked and clean
- Guard cycles: block rate 0.2–0.7%; stale-main blocks that bought nothing: 21 / 11.
- Stale-main health: weekend all healthy; the weekday cure-not-taking sessions are covered in finding 4.
- Wasted time: redundant builds 65/144 and 60/151, mostly single-spec vitest re-runs (30 / 15 min).
- Isolation: the usual root=primary findings for `.webpieces/worktrees/*` in ctoteachings; nothing new.
- Version skew: see Versions. No weekend impact.
- Matrix conformance: no MAJOR.
- Build ledger: max 3 concurrent; 17 / 35 overlap-minutes; median build 1.0–1.1 min; 2 orphans weekend.
- 3-point merges: historic churn only (monorepo4 #831 had 9 rounds, pre-window).
- Doc drift: the `/abs/path/to/build.log` template placeholder, and `.webpieces/build.log.bak` named in 4 CLAUDE.md files.
- Codex parity: weekend has no holes.
- Return-byte cost: re-emissions 1.3–1.5%; the largest always-loaded tax is monorepo3 at ~84k tokens.
- Token spend: see table; ~96% cache_read.
- Cycle time: reconciliation PASS.
