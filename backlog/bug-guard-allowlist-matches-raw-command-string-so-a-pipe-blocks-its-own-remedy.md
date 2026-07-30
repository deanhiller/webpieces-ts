# BUG: the Bash guard allowlist matches the raw command string, so `| head` blocks the very command the guard tells you to run

**Package:** `@webpieces/ai-hook-rules`
**Version seen:** `0.4.490`
**Severity:** High — the documented escape from `merged-branch-bash-guard` is "run one of these allowed
commands, then retry." An agent that appends `| head` or `| tail` (most of them do, to cap output) finds
every allowed command rejected, including `git fetch origin main`, which the guard's own error text
instructs it to run.

**Source:** `packages/tooling/ai-hook-rules/src/core/rules/merged-branch-bash-guard.ts` (allowlist match),
`packages/tooling/ai-hook-rules/src/core/rules/merged-branch-message.ts:61-64` (the advertised allowances)

Companion to [`bug-tree-recovery-forbids-git-checkout-main-in-the-primary-clone-where-it-is-the-easy-exit`](./bug-tree-recovery-forbids-git-checkout-main-in-the-primary-clone-where-it-is-the-easy-exit.md).

## Observed

Controlled pairs from one session on `mealco-internal/monorepo-nx`. Only the shell decoration differs:

| Command | Result |
|---|---|
| `pnpm wp-cleanup` | allowed |
| `pnpm wp-cleanup 2>&1 \| tail -40` | **blocked** |
| `git fetch origin main` | allowed |
| `git fetch origin main 2>&1; echo "…"` | **blocked** |
| `git log --oneline -3 origin/main` | allowed |
| `git log --oneline --no-merges … \| head -5` | **blocked** |
| `gh pr list --repo … --json …` | allowed |
| `for b in …; do gh pr list --repo … ; done` | **blocked** |

Row 2 is the one that matters: `git fetch origin main` is printed verbatim in the guard's own remedy
block, and adding `; echo` to it makes the guard reject it.

The allowance list advertises `git status|log|diff|show|branch` and `gh pr list|view|status` as
"read-only orientation." All four are reachable only when typed bare.

## Why it bites agents specifically

Piping to `head`/`tail` is the standard way to bound tool output. An agent following the instructions
literally — `git fetch origin main 2>&1 | tail -5` — gets blocked and has no signal that the *pipe*, not
the *command*, was the problem. The error text repeats the same command as the fix, so the natural next
move is to run it again the same way.

## Suggested fix

Parse the command line and evaluate the allowlist against the leading executable of each pipeline
segment, rather than against the raw string. `cmd | head`, `cmd 2>&1 | tail -n`, `cmd; cmd2`, and
`for … do cmd done` should each be judged on the commands they actually run — a pipeline is allowed iff
every segment is allowed. At minimum, strip trailing `2>&1`, `| head …`, and `| tail …` before matching,
since those are pure output shaping and cannot affect what the command does to the repo.

## Related: `gh run …` is not on the allowlist at all

Allowed: `gh pr list|view|status`. Blocked (bare, not just piped): `gh run view|list|watch`. These are
read-only, and watching CI is precisely what you do while parked on a just-merged branch waiting for the
next thing to start. `gh run view <id>` was blocked outright during this session while `gh pr view` beside
it succeeded.

## Related: `read-stale-guard` and `merged-branch-bash-guard` advertise mutually exclusive allowances

Both fire on the same branch. `read-stale-guard` prints:

```
Still allowed while this block is up:
  - EVERY Bash command (the git commands above, installs, builds, all git/gh)
```

while `merged-branch-bash-guard` is concurrently blocking most Bash. Each statement is true of its own
guard and false of the session. When several guards are active, print one merged allowance list rather
than each guard's independent view of the world.
