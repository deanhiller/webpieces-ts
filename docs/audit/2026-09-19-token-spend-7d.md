# Token spend & plan-vs-API cost, week of 2026-09-12

**Scope** — every session in `~/.claude/projects` (all 37 project dirs, main agents **and**
subagent transcripts) plus every `~/.codex/sessions` rollout, window
**2026-09-12T00:00:00Z → 2026-09-19T02:00:00Z** (7.08 days). 369 Claude transcript files.
`~/.claude-work` deliberately **excluded**, per the ask.

Counts are exact recorded usage (`message.usage` for Claude, `token_usage_record.usage` for Codex),
deduped by API response id so a resumed/forked session is not counted twice. Nothing here is
estimated from characters.

## 1. What you actually used

| | Claude Code (`~/.claude`) | Codex | Total |
|---|---|---|---|
| **Total tokens** | **6.561 B** | **4.166 B** | **10.73 B** |
| API calls | 20,823 | 33,914 | 54,737 |
| cache-read share | 97.8 % | 95.5 % | 96.9 % |
| fresh input | 0.04 M | 177.0 M | 177.1 M |
| cache write | 135.4 M | 0 | 135.4 M |
| **output** | **8.2 M** | **8.9 M** | **17.1 M** |
| models | opus-5 98.4 %, sonnet-5 1.6 % | gpt-5.6-sol 89 %, codex-auto-review 11 % | |

Per day (tokens / API-list-equivalent $):

| Day | Claude | Codex |
|---|---|---|
| Sat 09-12 | 0.894 B · $565 | 1.365 B · $806 |
| Sun 09-13 | 0.338 B · $238 | 1.375 B · $796 |
| Mon 09-14 | 1.484 B · $958 | 0.974 B · $594 |
| Tue 09-15 | 0.637 B · $432 | 0.451 B · $283 |
| Wed 09-16 | 1.164 B · $780 | — |
| Thu 09-17 | 1.597 B · $997 | — |
| Fri 09-18 | 0.445 B · $305 | — |
| Sat 09-19 (to 02:00Z) | 0.001 B · $2 | — |

**Codex stops dead after Tue 09-15 10:xx UTC** — zero rollouts on 09-16 → 09-19. That is the
week's hard stop, and it means the Codex column is a **4-day** number, not a 7-day one. Claude ran
all seven days and peaked Thu 09-17.

Where it went:

| Claude project | tokens | | Codex cwd | tokens |
|---|---|---|---|---|
| ctoteachings/monorepo3 | 2.435 B | | ctoteachings/monorepo2 | 1.632 B |
| ctoteachings/monorepo1 | 1.378 B | | ctoteachings/monorepo4 | 1.138 B |
| ctoteachings/monorepo2 | 0.640 B | | ctoteachings/monorepo1 | 0.334 B |
| onetablet/monorepo-nx3 | 0.598 B | | personal/webpieces-ts30 | 0.333 B |
| ctoteachings/monorepo5 | 0.467 B | | personal/webpieces-ts40 | 0.297 B |

**68 % of Claude tokens (4.462 B) are subagents**, not your main session — reviewers and
`/full-cycle` workers. Main agent is 2.099 B.

## 2. What the same work would cost on the API

List price, first-party, today: **Opus 5** $5 / $6.25 / $0.50 / $25 per Mtok
(input / cache-write / cache-read / output); **Sonnet 5** $2 / $2.50 / $0.20 / $10;
**GPT-5.6 Sol** $4 in / $0.40 cached / $20 out (Sol's $4/$20 is promotional through 2026-11-21 —
it was $5/$30). `codex-auto-review` is priced at Sol rates here; if it bills differently that one
$505 line moves.

| | this week | × 4.2 weeks = per month |
|---|---|---|
| Claude @ Opus-5 list | **$4,236** | **$17,792** |
| Codex @ GPT-5.6-Sol list | **$2,479** | **$10,411** |
| **Both** | **$6,715** | **$28,203** |

Cost composition — the cached prefix is the bill, not the output:

| Claude (Opus 5) | $ | | Codex | $ |
|---|---|---|---|---|
| cache read 6,316 M | 3,158 | | cache read 3,980 M | 1,592 |
| cache write 135 M | 846 | | fresh input 177 M | 709 |
| output 8.2 M | 205 | | output 8.9 M | 179 |

## 3. The comparison you asked for

| | Claude Max ($200/mo) | Codex/ChatGPT ($200/mo) | Both ($400/mo) |
|---|---|---|---|
| tokens/mo at this rate | 27.6 B | 17.5 B | 45.1 B |
| **plan cost per Mtok** | **$0.0073** | **$0.0114** | **$0.0089** |
| API list cost per Mtok (blended) | $0.646 | $0.595 | $0.626 |
| **plan is cheaper by** | **≈ 89×** | **≈ 52×** | **≈ 71×** |
| API bill you'd have gotten | $17,792/mo | $10,411/mo | $28,203/mo |

**Break-even**: the $200 Claude plan pays for itself at about **310 M tokens/month** at your blended
Opus-5 mix — you did **27.6 B**, ~89× past it. On the Codex side break-even is ~336 M/mo against
17.5 B used, ~52×.

Two honest caveats on those multiples:

1. **97 % of your tokens are cache reads**, and the API-equivalent above already prices them at the
   cheap $0.50/Mtok rate. So the 89× is not a cache artifact — it is real. But it does mean the
   figure is dominated by *re-reading context*, which is the one thing you could shrink without
   doing less work.
2. **API has no weekly cap.** The plan's 89× only exists because the plan throttled you: Codex went
   silent for the last 3 days of the week and you said Claude maxed too. On the API you'd have kept
   going — so the real API number for a week you *weren't* capped is higher than $6,715, not lower.

## 4. What this implies

- **Nothing about API pricing is close.** At 10.7 B tokens/week there is no configuration of API
  billing that competes with $400/mo of plans. The API is only worth reaching for on the specific
  days you are capped and the work cannot wait — a per-burst top-up, not a migration.
- **The lever that matters is the 68 % subagent share**, not price. Reviewer fan-out and
  `/full-cycle` workers are where 4.5 B of 6.6 B Claude tokens went; each one pays the full
  system-prompt + CLAUDE.md prefix on every call. Halving redundant reviewer re-runs buys back more
  headroom under the cap than any pricing change can.
- **ctoteachings/monorepo3 (2.4 B) and monorepo2 (1.6 B Codex) are 38 % of the fleet's week.** If
  you want to know where the cap went, it went there.
