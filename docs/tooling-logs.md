# Where the webpieces TOOLING logs live

Everything the webpieces **tooling** records about itself — every guard decision, every hook
invocation, every branch mutation, every blocked write — lands in one directory per git tree.

This is not about your application's logs. For those see [`ai.logging.md`](../ai.logging.md).

## The one directory

```
<primary-clone>/.webpieces/logs/                              ← the primary clone's own tree
<primary-clone>/.webpieces/worktrees/<git-worktree-name>/logs/ ← each linked worktree
```

Inside it, **the stream is a DIRECTORY and the writer is a FILE**:

```
logs/<stream>/<sessionId>-<agentId | "coordinator">-<hook>.log
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

## The directory is the LAYER

| stream directory | layer | what it records |
|---|---|---|
| `L-1-cd/` | L-1 | every `cd` the launch guard judged |
| `L0-shim/` | L0 | the sh shim's verdict on every tool call |
| `L1-location/` | L1 | every location decision, WITH its matrix row |
| `L2-decisions/` | L2 | every branch-state judgement and why |
| `calls/` | all | one line per guards-hook call, and how that hook ended |
| `async-refresh/` | — | the detached main-sync refresher's lifecycle, and its raw stdio |
| `rejections/` | — | blocked writes, plus a detail directory per writer |

This is what makes a layer greppable. Before it, `L2-decisions/` was the only decision stream and it
carried L0's `fault=` and L1's `root=`/`projectDir=`/`tree=` as COLUMNS — so "show me every L1
decision" had no answer at all, and L1's own allows were not recorded anywhere.

Nesting by STREAM is not the nesting this layout rejected. What it rejected was nesting by IDENTITY
(`sessions/<id>/<agent>/…`), which breaks every cross-session question. A one-level wildcard recovers
the flat view: `ls -t logs/*/<sid>-*` is still every layer at once, in time order.

## The filename is the WRITER

```
<sessionId>-<agentId | "coordinator">-<hook>.log
```

| segment | separates | source |
|---|---|---|
| `sessionId` | concurrent Claude Code windows | `session_id`, on every hook payload |
| `agentId`   | subagents within one window   | `agent_id` — absent for the coordinator |
| `hook`      | the hooks that run in PARALLEL | `guards` / `rules` / `guarantee-root` / the bin name |

One writer per FILE, by construction, so nothing needs a lock. This matters because `O_APPEND` is
indivisible only under `PIPE_BUF` — **512 bytes on macOS** — and measured across three repos, 6.3% of
the `calls/` stream's lines already exceed that. A shared file tears in practice, and the line that
tears is the long one: the `recover=` line a human needs most.

All three dimensions stay in the FILENAME even though the stream moved to the directory. `hook` in
particular cannot move: `wp-ai-guards-hook` and `wp-ai-rules-hook` are separate processes Claude Code
runs IN PARALLEL on the same tool call, so merging them into one file per writer would recreate the
tearing this whole scheme exists to remove.

One glob still answers each question:

```bash
ls logs/L1-location/         # one LAYER, every session
ls logs/*/<sessionId>-*      # one Claude Code window, every layer
ls logs/*/*-<agentId>-*.log  # one subagent, every layer
ls logs/*/*-guards.log       # one hook, across every session
```

**There is no un-prefixed spelling.** A writer that never identifies renders as
`unknown-coordinator-hook.log` — a distinct, greppable writer, not the shared file. Keeping a bare
name would be two reachable spellings of one filename with the *tearing* one reached by doing nothing.
See `LogStream` (`packages/tooling/ai-hook-rules/src/core/log-stream.ts`) for the full argument.

## The streams

| base name | written by | what it records |
|---|---|---|
| `calls/` | `decision-log.ts` (`InvocationLog`) | one line per guards-hook call, with how THAT HOOK ended |
| `L2-decisions/` | `decision-log.ts` (`logGuardDecision`) | one line per L2 judgement and why |
| `L1-location/` | `decision-log.ts` (`logL1Decision`) | every L1 outcome — block, exempt AND hand-down — with `row=` |
| `async-refresh/` | `main-sync-log.ts` + the child's raw stdio | the detached refresher's lifecycle, and any crash before its own logging |
| `rejections/` | `rejection-log.ts` | one line per blocked write, pointing at its detail file |
| `L0-shim/` | `templates/ai-hook.sh` (L0) | the sh shim's own audit of every tool call |
| `L-1-cd/` | `templates/guarantee-root.sh` (L-1) | every `cd` the launch guard judged |
| `branch-mutations.log` | `rules-config/src/branch-mutation-log.ts` | every workflow verb that renames, moves or deletes a branch |

The refresher's raw stdio has **no stream of its own**. It was a `.stderr.log` sibling that measured 0
bytes on every run — it is written to only when the detached child dies before its own logging, and
that is exactly when you want the crash output interleaved with the `SPAWN_ATTEMPT` above it rather
than in a second file you have to think to open.

`branch-mutations.log` is the one stream carrying a **bare** name. It is written by the `wp-*` bins,
one command at a time, and `LogStream` lives in `ai-hook-rules`, which *depends on* `rules-config` —
the import direction forbids reusing it there. If it ever gains a second concurrent writer it needs its
own stream identity first.

Each `<writer>.log` rotates at 512 KB into a `<writer>.1.log` sibling with the identical key.

## A `guards=` line is not the call's outcome

`calls/` records `guards=<action>` — **this hook's own answer, and nothing more.** Claude Code runs
all three PreToolUse hooks in PARALLEL, so no one of them can see another's verdict. Measured: a
`cd <repo>/packages && ls` DENIED by L-1 appears in `calls/` as `guards=ALLOW`, correctly, because the
guards binary had no objection to it.

**The true final action is the JOIN of `L-1-cd/` with `calls/`,** keyed by the identical
`<sid>-<agent>-<hook>` writer name and the command text. A `DENY` in `L-1-cd/` overrides. That is the
one fact a reader has to bring; nothing in a single stream can supply it.

`L-1-cd/` always lives at `$CLAUDE_PROJECT_DIR/.webpieces/logs/`, even for a call made inside a linked
worktree whose other streams sit under `worktrees/<name>/`. L-1 resolves no worktree on purpose: doing
so costs a `git rev-parse` subprocess on every Bash call, paid by the one layer whose whole guarantee
is that it reads no config, spawns no binary and touches no network.

## The verdict vocabulary is the matrix codebook

Every layer reports one of five actions (`Verdict` in `decision-log.ts`, GUARD_MATRIX.md's codebook):

| action | meaning |
|---|---|
| `ALLOW` | no objection — HANDED DOWN to the next layer |
| `ALLOW_EXEMPT` | out of scope by construction — allowed, evaluation stops |
| `ALLOW_FAIL_OPEN` | state could not be established, so nothing was judged |
| `BLOCK_AI_CURE` | blocked; the printed cure is a command the AI can run |
| `BLOCK_HUMAN` | blocked; needs a human decision |

Keeping `ALLOW_FAIL_OPEN` distinct is the point: it used to be a `' (fail-open)'` substring on the
reason field, so the abstentions were not countable and a guard quietly declining to judge looked
exactly like a guard approving.

`L1-location/` lines additionally carry `layer=` and `row=`. **`row=` is the row number the generated
doc prints** — `guards/L1-location.md` is rendered from the same array the guard consults — so a log
line joins to its matrix row by number, and checking behaviour against the documented use cases is a
lookup rather than an investigation.

## Rejection details

A blocked write produces two artifacts: one line in the index, and one Markdown file holding the whole
report plus the content that was refused.

```
logs/rejections/<sid>-<agent>-<hook>.log     ← the index
logs/rejections/<sid>-<agent>-<hook>/        ← its details, SAME writer key
    writeInfo-<epochMs>.md
```

The detail directory is named after the log that points at it, so it has exactly one owner for the same
reason the log does. The index line's pointer is relative to `rejections/`, so it resolves from where
the reader found it. Details are pruned after 7 days by the `<epochMs>` **in the filename** — no `stat`
call — and a stream directory emptied by that sweep is removed.

(Before this, details went to a `hooks/<YYYY-MM-DD>/` directory keyed only by the date and shared by
every writer in the tree. Two agents blocked in the same millisecond produced the same path and one
silently overwrote the other's evidence.)
