---
name: full-cycle
description: Hand a task to a subagent that owns it end to end with zero further human involvement — isolated worktree, implementation, gated PR, CI monitoring with self-repair, merge, and Linear ticket closure. Use when the user types /full-cycle, or says "full cycle this", "take this all the way", "do this end to end and merge it", or asks for a ticket to be delivered without check-ins.
---

# /full-cycle

`/full-cycle <task or ticket>` means: **you are done with this task after one delegation.** A subagent takes it from here and does not come back until the work is merged and the ticket is closed — or until it has genuinely failed and needs a human.

The whole point is that Dean does not get pinged mid-flight. Honor that.

## ⛔ READ THIS BEFORE ANYTHING ELSE: A GREEN PR IS A FAILED RUN

**`/full-cycle` ENDS WITH THE CODE ON `main`. NOT WITH A PR. EVER.**

This is true in EVERY repo, with EVERY configuration, with NO exceptions worth the name. If you
finish a `/full-cycle` run and the work is sitting in an open PR, you did not do the task.

**`pr-gate.mergeMode: NONE` IS IRRELEVANT HERE. So is any tool output saying "posted for a human to
merge (that is this repo's policy)".** That policy describes the DEFAULT flow — what happens when
nobody has said anything. **Typing `/full-cycle` IS Dean saying it.** The command exists precisely to
pre-authorize the merge. Reading a repo setting and concluding "so I should stop at the PR" inverts
the one instruction you were given. `pnpm wp-land-pr` lands the identical bytes from the CLI and is
the sanctioned route — use it.

Do not relay the tooling's "a person merges it" line back to Dean as if it were a blocker. He knows.
He typed the command that overrides it.

**Corollary — BEFORE you delegate, CHECK FOR AN EXISTING PR.** `gh pr list --state open` and look for
one already covering this work. Two agents in two checkouts building the same feature produces
duplicate PRs that conflict with each other on exactly the files both touched, and the cleanup costs
more than the feature did. This has happened; that is why it is written here.

**Corollary — a CONFLICTING PR is work still owed, not a reason to hand back.** See step 6.

## ⛔ SOME WORK IS NOT DELEGATABLE — DO IT HERE, MAIN AGENT, MAIN TREE

**Before you delegate, check whether the task can even survive a worktree.** A subagent runs in an
isolated worktree with its own checkout, and some work has no effect there — or actively breaks.

Do these **yourself, in this session, in the primary clone. Never in a subagent, never in a worktree:**

- **Upgrading webpieces** (`@webpieces/*` version pins, `pnpm-workspace.yaml` catalog, `webpieces.config.json`).
  The gate tooling a subagent runs IS webpieces — swapping it out underneath a running worktree gives you a
  half-old, half-new toolchain and a version skew the worktree cannot fix. The primary clone is where the
  installed toolchain actually lives.
- **Editing skills, agents or hooks** — `~/.claude/skills/**`, `~/.claude/agents/**`, `~/.claude/settings*.json`.
  These are global to the machine, not to a checkout, so a worktree buys nothing and a subagent editing the
  very instructions it is executing is a footgun.
- **Anything whose whole point is the state of THIS tree** — `pnpm install`, lockfile repair, cleaning
  dangling symlinks, and syncing `main`. Do NOT hardcode the main-sync command's name here: webpieces owns
  it and renames it between releases with no alias (`wp-checkout-clean-main` became `wp-sync-main`), so run
  whatever the guard's own cure line prints on THIS run.

For these, skip the delegation entirely: do the work, run the gate, land it, close the ticket — the
`/full-cycle` contract below still applies, you are just the one executing it.

## The one decision you make before delegating

**Is this task complex enough to need clarification?**

- **Complex** (multi-service, schema or infra touched, ambiguous requirements, a design choice that changes what gets built): ask your questions **now**, in the main session, via `AskUserQuestion`. Form a plan. *Then* delegate. This is the only window for questions — once the cycle starts, it is closed.
- **Simple** (a version bump, a doc fix, a well-specified ticket, a mechanical refactor): delegate immediately. Ask nothing.

When in doubt, prefer delegating — the subagent is instructed to guess and report, and a wrong guess on a small task is cheaper than an interruption.

## ⛔ BEFORE YOU DELEGATE: MAKE SURE THE WORK HAS A TICKET — MAIN AGENT, MAIN TREE

**Every change gets a tracker ticket, and the PR names it.** Which tracker depends on the repo:

| Repo | Tracker | Reference |
|---|---|---|
| `~/workspace/onetablet/*` | Linear | `ONE-NNNN` in the commit subject |
| `~/workspace/personal/*` | **GitHub issues** | `Fixes #NNN` in the PR body |
| `~/workspace/ctoteachings/*` | GitHub issues | `Fixes #NNN` in the PR body |

**If no ticket exists when the cycle starts, CREATE ONE FIRST, here, before you delegate.** The
ticket is where the reasoning lives — the alternatives you rejected, the acceptance criteria, the
measurement that motivated it. A PR whose rationale exists only in its own description loses that
context the moment it is squashed, and the subagent cannot create a ticket carrying reasoning it
was never told.

```bash
gh issue create --repo <owner>/<repo> --title "<what>" --body-file "$SCRATCH/req.md"
```

Use `--body-file`, never an inline `--body` string: request text is full of backticks, `$` and code
fences, and the shell will silently corrupt them.

**Then name the issue number in the spawn prompt** and tell the subagent to put a closing reference
(`Fixes #NNN`) in its PR body. The closing keyword matters — it is what auto-closes the issue on
merge and what carries the link into the squash-merge commit body, which is the only place it
survives into `main`'s history.

### The `backlog/` directory is RETIRED — do not recreate it

`~/workspace/personal/*` used to keep requests as untracked markdown in a `backlog/` directory.
That is gone: every file was migrated to a GitHub issue and the directory deleted.

**Do not write a `backlog/` file, do not recreate the directory, and do not hand a subagent a
backlog path.** If you find one in an old repo, the migration is: `gh issue create` with the file's
full content as the body, then `git rm` the file, both in the same PR as the work.

Why it was retired, so nobody reinvents it: those files were **untracked**, and `git worktree add`
copies only tracked files — so a request never reached the subagent's worktree at all. It would
invent a summary or skip it, while the only copy sat in the primary clone where another session's
`git add -A` could sweep it into an unrelated commit or delete it. That happened. An issue lives on
GitHub, is visible from every tree and every machine, and cannot be lost to a stray `git add`.

## Delegating

One `Agent` call, `isolation: "worktree"`, `run_in_background: true`. Pick the agent type that fits the work (`backend-dev`, `frontend-dev`, `db-specialist`, `general-purpose` as the default).

Give the subagent: the task, **the ticket number from the section above** (Linear key or GitHub issue), the target repo, any plan you formed, and **the contract below, in full**. It cannot read this file — you must inline it.

## The contract handed to the subagent

> You own this task end to end. You will not be able to ask questions — the human is not watching. Everything below is standing authorization; do not stop to confirm any of it.
>
> **1. Work in your worktree.** You have an isolated git worktree. Branch from the repo's default branch (`main` for monorepo-nx; for a repo under `repositories/*`, whatever `repos.json` names — usually `dev`). Branch name: `dean/one-NNNN-short-description`.
>
> Never `git merge`/`rebase`/`pull` from main into your branch — that is hook-blocked. Use `pnpm wp-start-update` if you need to catch up.
>
> **1b. Your PR body MUST name its ticket.** Put a closing reference in the PR body — `Fixes #NNN`
> for a GitHub issue, or the `ONE-NNNN` key for a Linear repo. Not only in the branch name, not only
> in the commit subject: **the body** is what GitHub parses for auto-close and what this repo's gate
> renders into the squash-merge commit, so it is the one place the link survives into `main`.
>
> You were given the ticket number in this prompt. If you genuinely were not, and the repo uses
> GitHub issues, **create one** (`gh issue create --body-file …`, never an inline `--body` string —
> backticks and `$` in the body will be shell-corrupted) and reference it. Do not stop to ask; a
> missing ticket is a ticket to make, not a blocker.
>
> **There is no `backlog/` directory any more.** It was migrated to GitHub issues and deleted. Do
> not create one, do not write a request file, and if you were handed a `backlog/` path, treat that
> as a stale instruction and say so in your report.
>
> **2. Implement the whole task.** Split across repos if it spans them — one commit and one PR per repository. Respect the PR-bucket rule: `libraries/kami/**`, `terraform/**`, and everything else are three separate PRs; docs ride along with any bucket.
>
> **3. Verify before you push — do NOT build the world.** The gate builds for you: `pnpm wp-review-upsert-pr`
> (step 4) runs the repo's configured `commands.pr-gate.buildCommand` and FAILS before any reviewer is spawned
> if it is red. That is the authoritative verification, it is scoped to your branch's fork point, and it is the
> same command the PR gate itself runs — so a second full build beforehand buys nothing.
>
> While you are writing code, use the tight loop only: one spec file (`pnpm exec vitest run <path>`) or one
> project (`pnpm nx run <project>:ci`).
>
> **NEVER re-run a command to see a different slice of its output.** This is the single most wasteful
> habit measured in real runs. One agent ran `nx run architecture:validate-code` FOUR times with no edit
> between — `| tail -40`, then `| grep -n`, then `| sed -n '38,60p'`, then `| grep "❌"` — and two separate
> agents re-ran an entire `wp-build` purely to re-read the `FullLog :` path their FIRST run had already
> printed and their own `| tail -25` had truncated away.
>
> So: **do not pipe `wp-build` through `tail`/`grep` on the first run.** Let it print, take the absolute
> `FullLog :` path, and from then on grep the FILE — `grep -n error "<that path>"`, `sed -n '1100,1230p'
> "<that path>"` — as many times and as many ways as you like. The whole point of the log file is that the
> build runs ONCE and is read MANY times. A second build with no edit in between cannot produce a
> different answer.
>
> **Give long commands an explicit `timeout`.** The Bash default is 120s and the cap is 600s; a command
> that exceeds it is moved to the background and you then burn many calls polling for its output (one
> measured agent reached 406 tool calls that way, including an `echo idle` sleep). `nx run <project>:test`
> and the `wp-*` gate commands routinely exceed 120s — pass `timeout: 600000` rather than discovering it.
> If a command genuinely needs longer than the 600s cap, wrap it in `wp-await.sh` and re-run on exit 2,
> exactly as step 5 describes. Never poll it back by hand, and do NOT background-and-stop: a stopped
> agent is not reliably re-invoked (see step 5 and issue #900).
>
> **Do NOT run a full/affected build before step 4 — not even once.** The gate builds, and it fails before
> spawning any reviewer, so a pre-gate build is pure duplication: measured, agents spent 0.8-6.1 min there,
> and one ran `wp-build` twice AND `wp-review-upsert-pr` twice, executing the build ~4 times in a single
> run. Go from the tight loop straight to step 4 and let the gate be the build.
>
> **Never run `pnpm run ci:local`, `pnpm run build-all`, `nx run-many` without `-p`, `nx affected` without
> `--base`, or a bare `pnpm exec vitest run`.** These build the whole monorepo. `ci:local` in particular chains
> a repo-wide `format:check`, a full `wp-ci` world build, and an unscoped `nx affected -t test` — it is the most
> expensive thing in the repo and agents running it in a loop are the main source of CPU contention (measured
> ~3.2x slower test times when several agents sweep at once).
> In an external repo (no webpieces gate): `npm run lint && npm run prettier && npm run build && npm test`.
>
> Commit format: `feat(scope): description ONE-NNNN`.
>
> **4. Open the PR through the gate.** Manual `git push` and `gh pr create` are hook-blocked. The flow is, in order:
>
> ```
> pnpm wp-start-upsert-pr     # 3-point merge if needed
> pnpm wp-review-upsert-pr    # build gate, materializes the diff, names reviewers
> pnpm wp-finish-upsert-pr    # opens the PR
> ```
>
> **Read what each command prints on THIS run and obey that** — webpieces owns the sequence and the file paths, and changes them between releases. Do not follow a remembered version.
>
> **Reviewers.** Spawn one separate subagent per **required** checklist the gate names, in parallel, each with a real `.claude/agents/<name>.md` and each handed the actual diff. Required today means `morpheus-wrapper-linear-required` and, when the diff touches `libraries/kami/**` or `terraform/**`, `morpheus-wrapper-terraform-kami-required` — but trust the gate's own labelling over this list.
>
> **NEVER spawn an optional reviewer. When the gate asks which OPTIONAL checklists to run, the answer is always "None — required only".** There is no task-level opt-in and no exception: blow straight through the optional list every time, on every `/full-cycle` run.
>
> This is not an override of AGENTS.md rule 7. Rule 7 routes that choice to the human ("optional checklists are the human's choice, put that choice to them exactly as the output frames it") — and in a full-cycle run there is no human at the prompt. Required-only is the correct unattended answer, for two reasons the gate itself states: a red from an *optional* reviewer blocks the PR exactly like a required one, so declining them removes a blocking risk you have no human available to adjudicate; and the optional list is computed from the finished diff, so it cannot be asked up front before the cycle starts.
>
> If a human genuinely wants an optional checklist run on some diff, that is an attended `pnpm wp-review-upsert-pr` at the prompt — not a `/full-cycle` run. Do not carry an optional-reviewer request into this contract.
>
> Never review your own work, never cover several checklists with one subagent, and never write a reviewer's verdict file on its behalf — `wp-finish-upsert-pr` checks for distinct subagent runs.
>
> **If a required reviewer comes back red: fix it.** Make a reasonable assumption, make the change, re-run the gate. Do not escalate.
>
> **NEVER go looking for a human override, and never ask for one.** An override requires the human's
> explicit in-session decision, and in a `/full-cycle` run there IS no human at the prompt — going to fetch
> one is the exact mid-flight interruption this command exists to eliminate, and in practice it stalled runs
> for hours waiting on somebody who was not watching. So there is no such thing as a "human-authorization
> gate" in a `/full-cycle` run, whatever mechanism the current release provides for one. If a required
> checklist is red, the answer is **make the diff satisfy it**: narrow the scope, split the PR, add the
> missing test, fix the ticket link — whatever the reviewer actually asked for. A red is a code/PR problem to
> solve, never an approval to go fetch.
>
> If, after a genuine attempt, the only way past a red would be an override, **stop and report** what the
> reviewer wanted and what you tried. Do not mint, request, or wait on an authorization.
>
> **5. WAITING — NEVER POLL BY HAND. USE `wp-await.sh`, IN THE FOREGROUND, AND RE-RUN ON EXIT 2.**
>
> ‼️ **This is the single most expensive mistake an agent makes, by a wide margin.** Every check you run
> by hand is a separate API call that resends your ENTIRE conversation — measured at **~557,000 tokens
> per turn**. One run spent **666 turns and 465M tokens** emitting `echo .` every three seconds while
> waiting for CI. Across the fleet in the 24h to 2026-09-07, **18.3% of ALL tokens** went to turns that
> did nothing: `echo .`, `echo idle`, `echo waiting`, `true`, `date`, and the same `gh pr checks <n>`
> over and over.
>
> **Polling is fine. One API call per poll is not.** So put the loop inside one command:
>
> ```
> ~/.claude/skills/full-cycle/scripts/wp-await.sh \
>     --run 'gh pr checks <n> --repo <owner>/<repo>' \
>     --while 'pending' \
>     --fail 'fail|cancel|timed_out' \
>     --timeout 545 --label 'CI #<n>'          # Codex: --timeout 245
> ```
>
> **BOTH harnesses now run it in the FOREGROUND and re-run on exit 2.** They differ only in the
> timeout, because their per-call ceilings differ.
>
> | you are | how | calls while waiting |
> |---|---|---|
> | **Claude Code** | **foreground**, Bash `timeout: 600000`, `--timeout 545`, re-run on exit 2 | ~2 |
> | **Codex** | **foreground**, `--timeout 245`, re-run on exit 2 | ~4 |
>
> ‼️ **DO NOT background-and-stop. That was this skill's instruction until 2026-09-11, and it is
> WRONG.** The harness does not reliably re-invoke a stopped subagent when its background job exits.
> Measured in [deanhiller/webpieces-ts#900](https://github.com/deanhiller/webpieces-ts/issues/900):
> three stalls across two subagents in a single session, each of which HAD launched `wp-await.sh`
> with `run_in_background: true` exactly as instructed. Every task-notification read *"stopped with
> no live background children of its own"*. Nothing woke them; the runs made **zero further
> progress** until a human poked them.
>
> Be precise about the cost, because it is easy to overstate: a stop costs only **~650 tokens and one
> tool call**, so backgrounding is cheap. The damage is that **the run does not finish**. Foreground
> costs ~2 context resends per 19-minute wait and does finish. That trade is worth it while the
> re-invoke is broken; revert to the background cure if the harness behaviour is fixed.
>
> **Claude's foreground cap is 600s** — measured, the call is demoted to background at exactly 600s
> and the result is lost — which is why `--timeout 545` leaves margin. Codex uses 245s against its
> 300s `write_stdin` cap.
>
> Real CI is longer than either ceiling, which is why exit 2 exists:
> `deanhiller/webpieces-ts` CI p50 **783s**, `ctoteachings/monorepo` CI p50 **723s**, max **1050s**.
> So expect ~2 calls on Claude and ~4 on Codex — against ~260 for checking by hand.
>
> Real CI is longer than any single call on either harness, which is why exit 2 exists:
> `deanhiller/webpieces-ts` CI p50 **783s**, `ctoteachings/monorepo` CI p50 **723s**, max **1050s**.
> (Claude's foreground cap is 600s if you ever need it — measured, the call is demoted to background
> at exactly 600s and the result is lost — so use `--timeout 545` there.)
>
> **`--timeout` is a CALL CEILING, not a wait.** The script exits the moment the condition is met, so
> it never makes you wait longer — it only says how long ONE call may block before handing you an
> exit 2 meaning "run me again". Set it just under your harness's cap (Claude 545, Codex 245). Setting
> it ABOVE the cap is worse than useless: the harness cuts the call off and you lose the result.
>
> **`gh pr checks` can serve STALE rows** — it reported `pending 0` for minutes after the run had
> finished. `wp-await.sh` now detects that (unchanged `pending`-with-`0` output across 4 polls) and
> cross-checks `gh run view`, returning the run's real verdict. You do not need to do anything; just
> do not be surprised by a success or failure line that cites `gh run view`.
>
> **It has three outcomes, and the middle one matters most:**
>
> | exit | meaning | what you do |
> |---|---|---|
> | 0 | green — nothing pending | proceed to step 6 |
> | 1 | **a check FAILED** | stop waiting immediately, read the output, fix it |
> | 2 | still waiting, timed out | run the IDENTICAL command again |
>
> Without `--fail` you would sit out the whole timeout on a run that went red in 90 seconds. Always pass it.
>
> **If auto-merge is armed** (`gh pr view <n> --json autoMergeRequest`), GitHub lands the PR itself the
> moment CI goes green, so you do not need to wait at all — **report immediately**, say auto-merge is armed
> with CI still running, and let the main agent verify the landing. Waiting there was measured at
> **10.3 min of one 39.5-min run, 26% of it**, for a merge that was going to happen anyway.
>
> Do not merge anything red.
>
> ‼️ **AN EMPTY CONCLUSION MEANS QUEUED, NOT "NEVER RAN". DO NOT CONFUSE THE TWO.** `gh pr view --json
> statusCheckRollup` reports a check that has not finished with an EMPTY `conclusion`, which looks
> identical to a check that never started. **CI normally runs here and is fast — measured at ~52s for
> `ci`, ~10s for `mobile-typecheck`.** So an empty conclusion seconds after `wp-finish-upsert-pr` means
> *wait a minute and look again*, nothing more. Reading it as "CI is dead, land anyway" is a real
> mistake that has been made in this repo, on a run where all three checks then passed. Take a second
> snapshot before you conclude anything, and never claim CI cannot run without the positive evidence
> in 5b.
>
> On failure: read the failing job's logs, fix the cause, push, wait again. **Up to 3 rounds.** If it is still red after the third, stop and report the failure with the log excerpt — do not merge, do not keep grinding.
>
> **5b. RED FOR INFRASTRUCTURE REASONS IS NOT RED CODE — LAND IT ANYWAY.** Before treating red as a code
> failure, establish which it is. The tell: **every check fails within a few seconds, no job ever started**,
> and `gh run view <id> --log-failed` answers `log not found` because there is no log to fetch. ‼️ A check
> still sitting with an EMPTY conclusion is NOT this — that is queued; see step 5. You need a check that
> actually reached a terminal state without running, or an explicit message. The commonest cause is
> Actions unavailable account-wide — this repo is on the FREE tier, so the usual trigger is the month's
> free minutes being exhausted, and the same shape appears for a billing block:
>
> ```
> The job was not started because recent account payments have failed
> or your spending limit needs to be increased.
> ```
>
> Also in this class: a runner outage, Actions disabled org-wide, an expired token on a required external
> check. What they share is that **the workflow never executed your diff**, so its red says nothing about
> your code.
>
> In that case **land the PR** with `pnpm wp-land-pr`. That is safe here for one specific reason: the
> webpieces gate already **built and tested your branch locally** — `pnpm wp-review-upsert-pr` runs
> `commands.pr-gate.buildCommand`, the same command CI runs, and refuses to continue if it is red; and
> every required reviewer had to return a passing verdict before `wp-finish-upsert-pr` would open the PR
> at all. The build genuinely ran. Only GitHub's copy of it did not.
>
> Conditions, all of them:
> - **Prove it.** Quote the billing/infrastructure message and note the jobs took seconds and produced no
>   logs. If ANY job actually ran and failed on your diff, this does not apply — fix it.
> - **The local gate must have been green on the commit you are landing.** If you pushed anything after the
>   last `wp-review-upsert-pr`, re-run the gate before landing.
> - **Say it ONCE, in a single clause**: landed with CI unable to run, evidence is the local gate rather
>   than GitHub. One sentence, then move on.
> - **NEVER report it as an outstanding action, and never route it back to the human.** We are on the
>   FREE tier and do not pay for Actions minutes, so CI **usually runs and passes** but **may stop
>   running once the month's free minutes are exhausted** — at which point we rely on the LOCAL build
>   (the webpieces gate, above) instead, for now. That is a known, accepted trade-off, not a lapse
>   anyone intends to repair. Do not tell the human to fix billing, do not call it a blocker, do not
>   put it in a task-list row, do not carry it into a follow-up, and do not offer it as a next step.
>   `/full-cycle` exists to NOT hand work back; a nag about a decision already made is exactly the
>   interruption this command is meant to eliminate.
>
> - ‼️ **DO NOT INVERT THIS INTO "CI NEVER RUNS HERE."** It is a state you must OBSERVE on this run,
>   not a standing property of the repo. The normal case is that all three checks — `ci`,
>   `mobile-typecheck` and `webpieces-pr-gate` — go green in about a minute. Skipping the wait because
>   you *assume* the quota is gone lands PRs on the gate alone and throws away a real signal you were
>   about to get for free.
>
> Do NOT stretch this to a flaky test, a timeout, or any job that ran and failed. Those are red code.
>
> **6. Land it** — only if auto-merge is NOT armed (if it is, step 5 already ended your run). Once every required check is green (or red for infrastructure reasons only, per 5b):
>
> - monorepo-nx → `pnpm wp-land-pr` (never `gh pr merge`; it writes the wrong squash subject). Lands on `main`.
> - a `repositories/*` repo → merge into that repo's default branch from `repos.json` (`dev` for most).
>
> Remember: landing on `main` in monorepo-nx means **ready for production** — any developer may promote that SHA. Make sure it actually is.
>
> **LANDING IS NOT OPTIONAL, AND NO REPO SETTING EXCUSES SKIPPING IT.** `/full-cycle` means the work
> ends up ON MAIN. A green PR left open is a FAILED run, not a completed one.
>
> In particular: `pr-gate.mergeMode: NONE` and `wp-finish-upsert-pr` printing *"posted for a human to
> merge (that is this repo's policy)"* are **NOT** a stop signal here. That policy describes the
> default flow, where no human has said anything. Invoking `/full-cycle` IS the human saying it —
> Dean has pre-authorized the merge, which is the entire point of the command. `wp-land-pr` lands the
> identical bytes from the CLI and is the sanctioned route; use it.
>
> The same goes for conflicts discovered at landing time. A `mergeable=CONFLICTING` PR is work still
> owed, not a reason to hand back: run `pnpm wp-start-upsert-pr` (NOT `wp-start-update` — that one
> refuses when a PR already tracks the branch, because it force-pushes without refreshing the PR
> body), resolve, `wp-review-upsert-pr`, `wp-finish-upsert-pr`, then land. Generated artifacts
> (`design.html`/`.json`/`.md`) conflict by construction between any two branches touching the same
> project — resolve those by taking main's copy and RE-RUNNING the generator over the merged tree
> (`nx run <project>:di-graph-generate`), never by hand-merging.
>
> Stop before landing only for: red CI after 3 fix rounds, or a required reviewer you could not satisfy
> by changing the diff. "The repo prefers humans to click Merge" is neither, and neither is an override you
> could not obtain — overrides are out of scope for this command entirely.
>
> **7. Close the ticket.** Linear repo: set state to `Done` via the Linear MCP and comment the PR link. GitHub repo: a `Fixes #NNN` in the PR body closes it on merge — **verify with `gh issue view <n> --json state`** and close it by hand if it did not, then comment the PR link on the issue.
>
> **8. Report back.** Your final message is the handoff. It must contain:
> - What you built, in a few lines.
> - The PR link as a clickable markdown link — `[#123 short title](url)` — never a bare `#123`.
> - CI outcome, including any red rounds and what you changed to fix them.
> - **Every assumption you made**, as a list. This is the part Dean reads. Anything you guessed at, any ambiguity you resolved on your own, any scope you decided was out — write it down.
> - Anything you deliberately did not do, and why.

## Reporting to the human

When the subagent finishes, relay its report — the subagent's output is not shown to the user. Lead with the PR link and the merged/closed status, then the assumptions list verbatim. Do not summarize the assumptions away; they are the review surface for a run nobody watched.

If the subagent stopped short (3 red CI rounds, or a required reviewer it could not satisfy), say so plainly at the top, with what it needs.

## Task-list status during a full cycle

When this work is tracked by `$list-tasks`, read and follow the canonical **Statuses** section in
`../list-tasks/SKILL.md`. Do not define or duplicate task-list states in this skill.

## Never

- Request, mint, or wait on a human override by any route. There is no human at the prompt.
- Ask a question after the cycle has started. Guess and report instead.
- Merge red — **except** the infrastructure case in step 5b (no job ever started: free Actions minutes exhausted for the month, billing block, runner outage, Actions disabled), where the local webpieces gate already built the branch and landing is correct. That case must be OBSERVED, never assumed: CI normally runs here in about a minute, and an empty conclusion means queued.
- Publish `libraries/kami/**` or `terraform/**` to dev, or check out `dev` in monorepo-nx.
- Push directly to `main`.
