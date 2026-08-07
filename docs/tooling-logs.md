# Where the webpieces TOOLING logs live

Everything the webpieces **tooling** records about itself — every guard decision, every hook
invocation, every branch mutation, every blocked write — lands in one directory per git tree.

This is not about your application's logs. For those see [`ai.logging.md`](../ai.logging.md).

## The one directory

```
<primary-clone>/.webpieces/logs/                              ← the primary clone's own tree
<primary-clone>/.webpieces/worktrees/<git-worktree-name>/logs/ ← each linked worktree
```

`.webpieces/` is gitignored. It is anchored at the **primary clone** even for a linked worktree, so a
worktree's history survives `git worktree remove` and the whole repo's history is one glob:

```bash
ls  <primary>/.webpieces/logs/
ls  <primary>/.webpieces/worktrees/*/logs/
```

Every writer resolves this directory through `dotWebpieces.logs()` / `logsFile()`
(`packages/tooling/rules-config/src/state-dir.ts`) — never by spelling a path — so the layout cannot
drift apart per-writer again. **There is no second state directory.** An earlier layout split the
tooling's state across `hooks/` (the binary's logs, mixed in with rejection detail files) and `logs/`
(the sh shim's log), so "where are the logs?" had two answers and neither was complete. `hooks/` is
gone; nothing reads or writes it.

## The filename is the WRITER

```
<sessionId>-<agentId | "coordinator">-<hook>-<base>.log
```

| segment | separates | source |
|---|---|---|
| `sessionId` | concurrent Claude Code windows | `session_id`, on every hook payload |
| `agentId`   | subagents within one window   | `agent_id` — absent for the coordinator |
| `hook`      | the hooks that run in PARALLEL | `guards` / `rules` / `guarantee-root` / the bin name |

One writer per FILE, by construction, so nothing needs a lock. This matters because `O_APPEND` is
indivisible only under `PIPE_BUF` — **512 bytes on macOS** — and measured across three repos, 6.3% of
`guard-invocations.log` lines already exceed that. A shared file tears in practice, and the line that
tears is the long one: the `recover=` line a human needs most.

Deliberately FLAT, not `sessions/<id>/<agent>/…`. One glob answers each question:

```bash
ls logs/                # every stream at once, in time order
ls logs/<sessionId>-*   # one Claude Code window
ls logs/*-<agentId>-*   # one subagent
ls logs/*-guards-*      # one hook, across every session
```

**There is no un-prefixed spelling.** A writer that never identifies renders as
`unknown-coordinator-hook-<base>` — a distinct, greppable stream, not the shared file. Keeping a bare
name would be two reachable spellings of one filename with the *tearing* one reached by doing nothing.
See `LogStream` (`packages/tooling/ai-hook-rules/src/core/log-stream.ts`) for the full argument.

## The streams

| base name | written by | what it records |
|---|---|---|
| `guard-invocations.log` | `decision-log.ts` (`InvocationLog`) | one line per guards-hook call, with how it ended |
| `guard-sync-decisions.log` | `decision-log.ts` (`logGuardDecision`) | one line per guard JUDGEMENT and why |
| `guard-async-work.log` | `main-sync-log.ts` | the detached main-sync refresher's lifecycle |
| `guard-async-work.stderr.log` | the refresher's raw stdio | crashes before its own logging runs |
| `hook-rejection.log` | `rejection-log.ts` | one line per blocked write, pointing at its detail file |
| `ai-hook-shim.log` | `templates/ai-hook.sh` (L0) | the sh shim's own audit of every tool call |
| `cd-audit.log` | `templates/guarantee-root.sh` (L-1) | every `cd` the location guard judged |
| `branch-mutations.log` | `rules-config/src/branch-mutation-log.ts` | every workflow verb that renames, moves or deletes a branch |

`branch-mutations.log` is the one stream carrying a **bare** name. It is written by the `wp-*` bins,
one command at a time, and `LogStream` lives in `ai-hook-rules`, which *depends on* `rules-config` —
the import direction forbids reusing it there. If it ever gains a second concurrent writer it needs its
own stream identity first.

Each `<name>.log` rotates at 512 KB into a `<name>.1.log` sibling with the identical prefix.

## Rejection details

A blocked write produces two artifacts: one line in the index, and one Markdown file holding the whole
report plus the content that was refused.

```
logs/<sid>-<agent>-<hook>-hook-rejection.log     ← the index
logs/<sid>-<agent>-<hook>-hook-rejection/        ← its details, SAME base name
    writeInfo-<epochMs>.md
```

The detail directory is named after the log that points at it, so it has exactly one owner for the same
reason the log does. The index line's pointer is relative to `logs/`, so it resolves from where the
reader found it. Details are pruned after 7 days by the `<epochMs>` **in the filename** — no `stat`
call — and a stream directory emptied by that sweep is removed.

(Before this, details went to a `hooks/<YYYY-MM-DD>/` directory keyed only by the date and shared by
every writer in the tree. Two agents blocked in the same millisecond produced the same path and one
silently overwrote the other's evidence.)
