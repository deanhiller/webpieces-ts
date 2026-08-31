# wp-cleanup: agent-liveness checks the SESSION pid, so every agent worktree looks live forever

## Who asked and why

Dean, in `monorepo-nx2`, after `git branch` showed **10 branches** and `git worktree list` showed
**9 worktrees** against a cap of 5 — while exactly **one** agent was actually running.

`pnpm wp-cleanup --report` spared eight of them with this, one line per worktree:

```
Worktrees deliberately left alone:
  · .../.claude/worktrees/agent-a250ec416639c8285 — locked by claude agent agent-a250ec416639c8285, pid 47053 still running — that agent is working in here
  · .../.claude/worktrees/agent-a4deca8e3b267dd28 — locked by claude agent agent-a4deca8e3b267dd28, pid 47053 still running — that agent is working in here
  · .../.claude/worktrees/agent-a7946960d7101fc20 — locked by claude agent agent-a7946960d7101fc20, pid 47053 still running — that agent is working in here
  … 5 more, same message, same pid
```

His words: *"but there is only 1 agent running ????? so wtf"*

He was right. Claude Code's own `/tasks` view showed a single subagent
(`backend-dev  Adding discover_hours_fixtures to smoke-management-api.sh`). The other seven agents
had finished hours earlier; several had already merged their PRs.

## The bug

**Every worktree reports the same pid — `47053` — because that is the Claude Code SESSION process,
not a per-agent process.** Subagents are not separate OS processes, so there is no per-agent pid to
check. The liveness heuristic therefore reduces to *"is Claude Code still open?"*, which is true by
construction for the entire life of a session.

This is the check the existing backlog entry
`feature-wp-cleanup-reap-zero-commit-refs-and-give-ai-flags-instead-of-a-prompt.md` describes as a
safe spare condition:

> a worktree holds the branch and is **LOCKED** by a live holder — a lock reason naming something
> still present, or **a claude-agent pid that is still running** — spare, and say so

That condition is sound in principle and **unimplementable as written**, because the pid it can
observe is never the agent's.

### Consequences

1. **Worktrees accumulate monotonically across a session and `wp-cleanup` can never take any of
   them** — not `--report`, not `--delete-worktrees=all`, no flag. Nothing in the tool's own
   vocabulary expresses "this lock is stale".
2. The worktree cap (5) is exceeded silently. Dean hit 9.
3. **The message is actively misleading.** "that agent is working in here" is stated as fact about
   seven agents that had finished, some of whose PRs were already merged. Dean reasonably read it as
   "eight agents are running" and had to challenge it to find out otherwise.
4. It defeats the *whole* zero-commit reaping feature for agent worktrees, which is the population
   that generates them fastest.

### The workaround, which should not be necessary

```bash
git worktree unlock .claude/worktrees/agent-<id>   # for each stale one, by hand
pnpm wp-cleanup --delete-worktrees=all
```

After unlocking seven, `wp-cleanup` immediately classified all seven correctly — six as
`PR #NNNN merged` (auto-reaped, no question asked) and one as `never had a PR; holds 1 unique
commit` (offered for decision). **It had the right answer all along**; the pid check was suppressing
it. It also correctly kept sparing the one genuinely live agent, which is the proof the rest of the
classifier is fine.

Requiring a human to hand-unlock N directories before the cleanup tool can clean up inverts the
point of the tool.

## What to change

**Stop inferring agent liveness from a pid.** It cannot work for in-process subagents. Options, best
first:

1. **Ask the harness.** Claude Code knows exactly which subagents are live — `/tasks` renders it and
   a `ListAgents` tool returns it. If any of that is reachable from a `wp-*` bin (a state file, a
   socket, an env var naming the live agent ids), use it and drop the pid check entirely.
2. **Write liveness into the lock, and expire it.** Have whatever creates the worktree stamp the
   lock with a heartbeat timestamp refreshed while the agent runs. A lock whose heartbeat is older
   than some threshold is stale and reapable. Self-healing, no harness coupling.
3. **Fall back to evidence the tool can already see.** A worktree with a clean `git status
   --porcelain` **and** a merged PR for its branch is done, whatever the lock claims — that
   combination cannot be true of an agent mid-flight. This alone would have reaped six of Dean's
   seven.
4. **At minimum, expose an escape hatch and tell the truth.** A `--ignore-stale-locks` /
   `--force-unlock` flag, and stop asserting "that agent is working in here" when the only evidence
   is that the *editor* is open. Say what is actually known: *"locked by agent <id>; liveness cannot
   be verified (pid is the shared session process)"*.

Option 3 is cheap and independently correct — worth doing regardless of which of 1/2 lands.

## Done when

- A session that has run N agents and finished them leaves **zero** stale worktrees for
  `wp-cleanup`, with no hand-unlocking
- A **live** agent's worktree is still spared (do not regress the case the check exists for)
- No message claims an agent is working in a directory unless that is actually known
- Verified by: run several agents to completion in one Claude Code session, keep the session OPEN,
  run `pnpm wp-cleanup` — every finished agent's worktree is classified on its real merge/commit
  state, and only the running agent's is spared
