# BUG: when a worktree is reaped out from under a live shell, L1 misdiagnoses the vanished cwd as "a subdirectory" and prescribes a remedy that `cd`s back into the deleted directory — compounding on every retry

**Package:** `@webpieces/ai-hook-rules`
**Severity:** MEDIUM-HIGH — a hard session deadlock with no in-band recovery. The agent cannot follow
the instruction it is given, and each attempt makes the command worse.
**Versions verified:** symptom observed live on `0.4.603`; the `gitToplevel()` code path is unchanged
through `0.4.614`.
**Sibling defect:** see
`bug-every-claude-worktrees-worktree-is-ungoverned-so-every-bash-guard-is-silently-skipped.md` —
same root cause (reasoning about worktrees by path shape instead of asking git).

**Source:**
- `packages/tooling/ai-hook-rules/src/core/effective-tree.ts:263-268` — `gitToplevel()`
- `packages/tooling/ai-hook-rules/src/core/effective-tree.ts:181-189` — `classify()` fast path
- `packages/tooling/ai-hook-rules/src/core/runner.ts:258-271` — `gitFromSubdirBlock()`, the message

---

## What is wrong

`gitToplevel()` returns `null` for two very different situations: *"this is not a git directory"* and
*"this directory does not exist"*. The second is what an agent hits when its worktree is reaped out
from under it — the shell's cwd still names a path that is now gone.

`classify()` then falls through to `('primary', governedRoot)` at `:186`, and `gitFromSubdirBlock`
sees `effectiveCwd !== root` and blocks as though the agent had merely wandered into a subdirectory.

## Observed live (`0.4.603`)

A subagent was launched with cwd `<root>/.claude/worktrees/agent-a5931637c5bff6d6d`. Mid-session
another agent's cleanup removed that worktree. Every subsequent `git`/`gh` call produced:

```
❌ Run git/gh commands from the repo root, not a subdirectory.
   Command runs in: <root>/.claude/worktrees/agent-a5931637c5bff6d6d
   Judged against:  <root>
   Run EXACTLY this instead, as ONE line …
     cd '<root>' && cd <root>/.claude/worktrees/agent-a5931637c5bff6d6d && git fetch origin main && …
```

The prescribed remedy ends by `cd`-ing back into the directory that no longer exists, so it cannot
satisfy the check. Following it verbatim re-fires the identical violation with the prefix now doubled,
and a third attempt triples it:

```
cd '<root>' && cd '<root>' && cd <root>/.claude/worktrees/… && git …
```

Three rounds were burned before the real state (`git worktree list` shows only the primary;
`EnterWorktree` returns `ENOENT`) became visible. Nothing in the message hints that the directory is
gone — it reads as an ordinary "you are in a subdirectory" scolding, which is a misdiagnosis.

## Fix

1. **Distinguish the two `null`s.** Have `gitToplevel()` (or its caller) check `fs.existsSync(dir)`
   first and return a distinct `missing` classification.

2. **Give `missing` its own message** that names the actual problem and whose remedy does **not**
   route through the dead path:

   ```
   ❌ The directory this shell is in no longer exists:
        <root>/.claude/worktrees/agent-a5931637c5bff6d6d
      It was a git worktree that has since been removed (git worktree list no longer shows it).
      Nothing can run there. Continue from the repo root — and if you were mid-task in that
      worktree, your uncommitted work in it is gone:
        cd '<root>' && <the rest of your command>
   ```

3. **Assert the general invariant in a test, because this is a class of bug and not an instance:**
   a remedy L1 prints must never be a transformation that leaves the violated predicate true. Feeding
   any block's suggested command back through the runner must not reproduce the same guard.
   `atRoot()` composing `cd <root> && <original command>` when the original command already begins
   with a `cd` to a *different* tree is exactly that failure, and it is why the prefix accumulated.

## Related — probably one root cause upstream

Something reaped a **live** worktree belonging to a running agent. The existing entry
`bug-wp-cleanup-reaps-dead-branches-but-never-dead-worktrees-so-both-accumulate-forever.md` argues the
opposite direction; whatever now removes worktrees needs a liveness check (an owning agent session, or
simply a non-empty `git status`) before removing one, or this defect keeps recurring.

Also worth noting against
`bug-branch-creation-guard-calls-live-worktrees-dead-and-miscounts-parked-branches.md`.

## Test cases

1. cwd = a worktree path that has been **deleted**, any `git` command → blocked with the *directory is
   gone* message, and the suggested command contains **no** `cd` into the deleted path.
2. Property test: for every guard that emits a suggested command, running that suggestion back through
   the runner does not re-trigger the same guard.
3. cwd = `<root>/packages/http`, command `git status` → still blocked as a genuine subdirectory (no
   regression).
