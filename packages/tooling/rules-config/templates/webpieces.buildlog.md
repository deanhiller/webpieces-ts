# Where the build's output is — read the printed path, never a remembered one

`pnpm wp-build` and the PR gate's build stages send the build's **entire** stdout and stderr to a FILE.
Your terminal gets a heartbeat and a summary; it never gets the build output. So every question about a
build ("what failed", "did the tests run", "what was that warning") is answered by reading a file — never
by running the build again.

## THE RULE

**Read the log at the absolute path the `FullLog :` line of THIS run printed.**

Every run — success or failure — ends with two lines:

```
FullLog : /abs/path/to/build.log
(a second line, naming that log's `.bak` — the previous run is rotated aside on every build)
```

Copy that path. `grep -n error "<the FullLog path>"` always works. A path typed from memory does not:
it either greps a file from some other tree or greps nothing at all and reports "no matches", which
reads exactly like a clean build.

## WHY A REMEMBERED PATH IS WRONG MORE OFTEN THAN IT IS RIGHT

webpieces state is worktree-namespaced **inside the primary clone**, not duplicated per worktree:

| where you are standing | where `wp-build` writes |
|---|---|
| the primary clone | `<primary>/.webpieces/build.log` |
| a linked worktree (the normal case for a subagent) | `<primary>/.webpieces/worktrees/<worktree-name>/build.log` |

A relative `.webpieces/build.log` inside a linked worktree **does not exist at all**. Those two rows are
an illustration of why you read the printed path — they are not a lookup table to memorise, and the
namespacing scheme is webpieces' to change.

The PR gate's own build stages use a different name again — `logs/build-gate-<stage>-<branch>-<sha>.log`
— precisely because two stages can build the same commit and neither may overwrite the other's evidence.
Nobody types those names either. The failure message prints them.

## WHAT THE CONSOLE GIVES YOU WHILE IT RUNS

A heartbeat every few seconds: `<log> size <n> lines`, with the word `still` appended when the count has
not moved since the last tick. `still` is the load-bearing word — a build that is linking, or waiting on
a cold nx cache, produces no output for minutes, and without it you cannot tell a stalled BUILD from a
stalled reporter. Neither one is a reason to start a second build.

## ON A RED BUILD

The failure summary already echoes the last lines of the log, so the immediate cause usually needs no
second command. For anything more, `grep` the FILE.

**Never re-run the build to see a different slice of its output.** That is the whole reason the file
exists: one measured session spent 23.9 minutes across nine builds, five of them with no code change in
between, walking `| tail -50` → `> /tmp/file` → `| grep` → `| sed -n '1100,1230p'` over output that had
already scrolled past. Every one of those is a `grep` of the `FullLog :` file now — and the run before it
is still on disk as `.bak`.

If you read that file and find no failure in it, something upstream is wrong (a runner that died without
printing, a truncated redirect). Report that contradiction to the human and stop. Do not guess, and do
not rebuild.

## WHAT TO RUN, AND WHAT NOT TO

One command: **`pnpm wp-build`**. It runs `commands.pr-gate.buildCommand` from `webpieces.config.json`
verbatim, through the same resolver the PR gate's build stage uses, and prints the command it resolved
before running it — so a green result locally is evidence about the gate.

Do not hand-compose a verify chain of your own, and do not add a leg to `wp-build`. Anything that must
run on every build belongs *inside* `buildCommand`, where the gate runs it too. For the inner loop, run
the one spec file you are changing.
