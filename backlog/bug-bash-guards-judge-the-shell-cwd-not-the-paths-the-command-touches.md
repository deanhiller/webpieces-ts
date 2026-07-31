# BUG: bash guards judge the shell's cwd, not the paths a command actually touches — so commands aimed outside the repo are blocked, and the prescribed cure can be impossible

**Package:** `@webpieces/ai-hook-rules`
**Version seen:** `0.4.499`
**Severity:** High — three distinct sightings in one session (2026-07-30), each costing turns. In one the
guard's own remedy was a command the agent had been explicitly forbidden to run.

**Source:** `packages/tooling/ai-hook-rules/src/core/runner.ts` (how `ctx.workspaceRoot` / cwd is resolved),
`stale-main-bash-guard.ts`, `merged-branch-bash-guard.ts`, `content-read-scan.ts`

Related — same root cause, different symptom:
[`bug-bash-guards-judge-foreign-repo-exclusion-on-pre-cd-cwd-and-ignore-excludepaths`](./bug-bash-guards-judge-foreign-repo-exclusion-on-pre-cd-cwd-and-ignore-excludepaths.md),
[`bug-force-to-root-still-uses-pre-cd-cwd-so-cd-root-and-git-is-blocked-from-a-nested-clone`](./bug-force-to-root-still-uses-pre-cd-cwd-so-cd-root-and-git-is-blocked-from-a-nested-clone.md).
This one adds the multi-worktree case and the impossible-remedy case.

## Why it is structural, not incidental

An agent's Bash tool does **not persist `cd` between calls** — verified directly: a standalone
`cd <worktree>` followed by `pwd` in the next call returns the primary clone. So an agent working in a
worktree issues either absolute paths or `cd X && …` compounds, and the shell's cwd is *always* the
primary clone. Every guard that reasons from cwd therefore judges the wrong tree on every call.

## Sighting 1 — a command targeting a path outside the repo entirely

```
ls -la /Users/deanhiller/.claude/projects/ | grep -i monorepo-nx2
  → [merged-branch-bash-guard] blocked: "…this branch is merged…"
```

Nothing in that command touches the repo. It was blocked because cwd happened to be a repo whose branch
was merged.

## Sighting 2 — the cure could not be typed from where it was needed

A version-drift guard demanded, verbatim and character-for-character, `pnpm install`, and explicitly
forbade prefixing it with `cd`:

```
do NOT put a cd in front of it, do NOT wrap it in a subshell. The allowlist is anchored to the
ENTIRE command …
```

But the install was needed in a *worktree*, and cwd was the primary clone. The rule as written makes the
cure unreachable from the directory that needs it. A bare `cd <worktree>` was itself blocked.

## Sighting 3 — the remedy was a forbidden action

An agent working in a worktree ran a command whose target was its own scratchpad under `/private/tmp`.
`stale-main-bash-guard` blocked it because cwd (the primary clone) was on a `main` that was 2 commits
behind. Its remedy was `git pull --ff-only origin main` — i.e. **mutate the primary clone**, which that
agent had been explicitly instructed not to touch. Correct-by-its-own-logic, impossible in context.

## The fix has TWO halves — detection AND steering

Both are required. Fixing detection alone still leaves the AI stranded in the wrong directory.

### Half 1 — detect the effective worktree root

**Resolve the tree from the command, not the shell.** Parse a leading `cd <path> &&` (already segmented
by `ShellSegmentScan` from #509) and evaluate against that path's git tree. `WorktreeService` already
enumerates worktrees and distinguishes the primary clone from linked ones — reuse it to map any path to
its owning worktree root rather than writing new resolution.

`force-to-root` has its own copy of this problem (see the related ticket) — **both must share ONE
resolver**, or they will disagree about which tree you are in.

### Half 2 — steer the AI back to the worktree root, and ACCEPT the result

This is the half that is missing today and the reason the guards wedge rather than merely misjudge.

When a guard resolves a different root than the shell's cwd, it must print the **exact runnable command**:

```
cd <worktree-root> && <your original command>
```

…and the allowlist must **accept that form**. Today it does the precise opposite — it anchors to the
entire command string and explicitly instructs:

```
do NOT put a cd in front of it, do NOT wrap it in a subshell. The allowlist is anchored to the
ENTIRE command …
```

So the prescribed cure is unreachable from a worktree, and a bare `cd <worktree>` is itself blocked. An
allowlist entry MUST tolerate a leading `cd <path> &&` for the commands it prescribes; the `cd` cannot
change what the command does to the repo, so it cannot be a safety concern.

Because a Bash tool call does not persist `cd`, **every** prescribed remedy should be emitted in the
`cd <root> && …` form — an agent cannot rely on already being there, and the next tool call will have
reset to the primary clone regardless.

### Remaining fixes
- **Judge each segment against the paths it actually touches.** `content-read-scan` already extracts read
  targets; if every target is outside any git repo under management, the stale/merged guards have no
  claim. A command touching only `/tmp` is not reading a stale tree.
- **Make the cure reachable.** If an allowlist is anchored to the entire command string, it must accept a
  leading `cd <path> &&` for the very commands it prescribes — otherwise the remedy is unreachable from
  a worktree. Alternatively prescribe the remedy WITH the `cd` already in it, naming the directory.
- **Never prescribe mutating a tree other than the one the command targeted.** In a multi-worktree repo,
  "pull main" may be someone else's tree.
- **Consider surfacing the judged tree in the message** ("evaluated against `<path>` (branch `<b>`)"), so a
  wrong judgement is visible instead of baffling.

## Before you start — worktree cap

Parallel ticket work runs several subagents at once, each in its own worktree, so
`hookGuards → branch-creation-guard → maxWorktrees` is **10** in `webpieces.config.json`.
`maxLocalBranches` stays at **5** deliberately — branches outside a worktree are worked one at a time.

Both keys are already on `origin/main`, so you inherit them: **change nothing.** If you hit a conflict on
those lines while syncing, take main's value.
