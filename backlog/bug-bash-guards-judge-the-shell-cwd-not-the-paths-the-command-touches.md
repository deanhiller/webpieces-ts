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

> ⚠️ **The claim in this section is FALSE as written — see ADDENDUM 2 at the bottom before relying on
> it.** It is kept, struck through, because two later sections argue *from* it and the record of what
> was believed matters. Corrected rule: a `cd` that stays INSIDE the workspace **persists**; one that
> **leaves** it is reset by the harness. The section's CONCLUSION survives — a worktree is outside, so
> a command issued from one is judged against the primary clone — but not for the reason given here.

~~An agent's Bash tool does **not persist `cd` between calls** — verified directly: a standalone
`cd <worktree>` followed by `pwd` in the next call returns the primary clone.~~ So an agent working in a
worktree issues either absolute paths or `cd X && …` compounds, and the shell's cwd is *always* the
primary clone. Every guard that reasons from cwd therefore judges the wrong tree on every call.

## Sighting 1 — a command targeting a path outside the repo entirely

```
ls -la /Users/deanhiller/.claude/projects/ | grep -i consumer-monorepo2
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

Because the next tool call's cwd cannot be predicted — a `cd` inside the workspace STICKS, one that
leaves it is RESET (see ADDENDUM 2) — **every** prescribed remedy should be emitted in the
`cd <root> && …` form. An agent cannot rely on already being in the right place in either direction.

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

---

# ADDENDUM (2026-08-02) — the "does not persist `cd`" premise is FALSE, and the guard message says so out loud

**Read this before acting on the sections above.** The load-bearing premise in *"Why it is structural,
not incidental"* — that an agent's Bash tool does not persist `cd` between calls — **does not hold on
the current harness.** It was measured directly this session, in both command shapes:

| # | tool call | command | result |
|---|---|---|---|
| 1 | A | `pwd` | `…/consumer-monorepo4` |
| 2 | B | `cd docs && pwd` | `…/consumer-monorepo4/docs` |
| 3 | C | `pwd` *(fresh call, no `cd`)* | **`…/consumer-monorepo4/docs`** |
| 4 | D | `cd …/consumer-monorepo4/docs` *(standalone, no `&&`)* | *(no output)* |
| 5 | E | `pwd` *(fresh call)* | **`…/consumer-monorepo4/docs`** |

Rows 3 and 5 are separate tool invocations containing no `cd` at all, and both report the subdirectory.
**`cd` persists — compound and standalone alike.** The Claude Code Bash tool documents this explicitly:
*"Working directory persists between calls."*

The earlier observation may have been accurate against an older harness (this report was written at
`0.4.499`), so this is a re-measurement rather than an accusation — but the current behavior is
unambiguous and the sections above should be re-derived from it.

## The guard's own message asserted the false premise — and refuted itself doing so

**FIXED in PR #558/#562 — the block below is the OLD text, quoted as evidence, not current behaviour.**

Verbatim, from a block hit three times in one session:

```
Run EXACTLY this instead (one line — `cd` does NOT persist between tool calls):
  git -C /other/repo status
```

The remedy is *"prefix with `cd <repo-root> &&`."* That remedy is only necessary **because** cwd
persisted and left the agent in a subdirectory. If `cd` genuinely did not persist, every call would
start at the repo root and this guard could never fire at all. The parenthetical contradicts the fix it
is attached to, and it actively misleads: it tells the reader the exact state that produced the error is
impossible.

**How the state arose, concretely.** An earlier, unrelated command read some verdict files:

```
cd .../.webpieces/pr-review/feature-ONE-2252-.../ && for f in review-*.json; do …; done
```

That `cd` persisted. The *next* command targeted a different repo entirely
(`git -C /Users/deanhiller/workspace/personal/webpieces-ts50 status`) and was blocked — judged against
`consumer-monorepo4` because the shell happened to still be sitting inside it.

## This makes the underlying bug worse, not better

The report currently argues cwd is *predictably wrong* (always the primary clone). The truth is cwd is
**arbitrarily** wrong — it is wherever the last `cd` in the session left it, which no guard, and no
agent reading the guard's message, can predict. Concretely:

- A remedy emitted as bare `pnpm install` may run in a **subdirectory** rather than the primary clone —
  not merely "the wrong worktree." The existing advice to always emit `cd <root> && …` is therefore
  **more** important than the report claims, not less; the stated reason for it is just wrong.
- `--force-to-root` and every "pre-`cd` cwd" behavior described in the sibling reports needs re-checking
  against persistence, because their expected-cwd assumption no longer holds.
- Sighting 1 (`ls -la ~/.claude/projects/…` blocked by a merged-branch guard) is now explained more
  simply: cwd was a merged-branch repo *left over from an earlier call*, not the tool's default.

## Two fixes

**1. Correct the message text.** Replace the parenthetical with something true:

> `cd` **persists** between tool calls, so an earlier command may have left you in a subdirectory.
> Prefix this one with `cd <repo-root> &&` — and add that prefix again on later commands, since this
> one does not permanently move you back either.

Also worth surfacing the judged tree in the same block (already listed under *Remaining fixes*): a line
like `evaluated against <path> (cwd <cwd>)` would have made this diagnosable in seconds instead of
turns.

**2. Prefer the command's explicit target over cwd — `git -C` is the easy win.** Every blocked command
in this session's sightings named its repo explicitly:

```
git -C /Users/deanhiller/workspace/personal/webpieces-ts50 status --short
```

`git -C <path>` is unambiguous about which repo it touches regardless of cwd; the same holds for
`git --git-dir`/`--work-tree` and for `gh -R <owner/repo>`. A guard that parsed those flags could judge
the actual target and would not have fired on any of the three sightings. This is the concrete,
low-risk version of *"Judge each segment against the paths it actually touches"* already listed above —
it needs no path-resolution heuristics, just reading a flag the command already carries.

**Frequency note:** three hits in one session, every one a false positive, and every one triggered by a
`cd` made for an unrelated read several turns earlier.

---

# ADDENDUM 2 (2026-08-02) — BOTH of the above are right, about different cases: `cd` persists WITHIN the working dir and is RESET when it leaves

**Read this before acting on either section above.** The original report says `cd` never persists.
Addendum 1 says it always persists. Re-measured on `webpieces-ts50`, both are half-right, and the
distinction is exactly the one the guards care about:

| # | tool call | command | result |
|---|---|---|---|
| A | 1 | `pwd` | `…/webpieces-ts50` |
| B | 2 | `cd backlog && pwd` | `…/webpieces-ts50/backlog` |
| C | 3 | `pwd` *(fresh call, no `cd`)* | **`…/webpieces-ts50/backlog`** ← persisted |
| D | 4 | `cd /Users/…/ts50-reports && pwd` *(a LINKED WORKTREE)* | `…/ts50-reports`, then the harness printed **`Shell cwd was reset to /Users/…/webpieces-ts50`** |
| E | 5 | `pwd` *(fresh call)* | **`…/webpieces-ts50`** ← reset, did NOT persist |

**The rule: `cd` persists while it stays inside the session's working directory, and the harness
resets it — announcing `Shell cwd was reset to <root>` — the moment a command leaves that tree.** A
linked worktree is outside it, which is why the original report measured "never persists" (it was
working in worktrees) and Addendum 1 measured "always persists" (it `cd`-ed into a subdirectory of
the same repo). Neither was wrong about what it ran; both over-generalized.

## What this changes for the fix

- **cwd is NOT arbitrary** (Addendum 1's central claim). Its range is exactly: the session root, or a
  SUBDIRECTORY of it. It can never be another worktree or `/tmp`, because the harness resets those.
  That is a much smaller space to reason about than "wherever the last `cd` left it".
- **The original report's Sighting 3 stands and is now explained.** An agent working in a worktree
  really does get judged against the primary clone, every time — not by accident of an earlier `cd`,
  but because worktree `cd`s are structurally reset. The impossible-remedy problem is real.
- **`cd <worktree> && …` remains mandatory, and the allowlist must accept it** — Addendum 1's
  conclusion holds, for the original report's reason rather than its own.
- **New requirement neither section states: a guard must tolerate cwd being a SUBDIRECTORY of the
  repo root.** That is the one case where `cd` genuinely sticks, so a relative path resolves against
  somewhere other than the root while still being inside the governed tree.

## ✅ RESOLVED — the message text (the rest of this report is still OPEN)

The false premise is **gone from the source**: all 11 assertions across `runner.ts`, `effective-tree.ts`,
`tree-recovery.ts`, `merged-branch-message.ts`, `content-read-scan.ts`, `l0-allowlist.ts` and `shim.ts`
now state the two-case rule instead, and the user-facing block at `runner.ts` no longer tells the AI
the thing that is not true. The `cd <root> && …` conclusion is unchanged — only its reason was wrong.

Still open, and the substance of this report: **judging the paths a command actually touches** rather
than the shell's cwd, and the `git -C` / `gh -R` win below. Do not close this ticket on the message fix.

## The message text that was corrected, and why the obvious replacement was also wrong

`runner.ts:223` USED TO say `cd` does NOT persist between tool calls. The premise was asserted in **19
places** — 11 in non-spec source (`effective-tree.ts`, `runner.ts`, `merged-branch-message.ts`,
`content-read-scan.ts`, `tree-recovery.ts`, `l0-allowlist.ts`, `shim.ts`), plus `GUARD_MATRIX.md` and 7
spec files. **All 19 are fixed** (PR #558 took the first 11; PR #562 took the 8 that a directory-scoped
grep had missed, including the human-facing `GUARD_MATRIX.md`). Addendum 1's proposed replacement
("`cd` **persists**…") would have been just as wrong in the other direction. The honest version, now
shipped:

> `cd` persists between tool calls while it stays inside this workspace, and is reset when a command
> leaves it. So an earlier command may have left you in a SUBDIRECTORY — prefix this one with
> `cd <repo-root> &&`. For a linked worktree the prefix is required every time, since the harness
> resets you out of it after each call.

Surfacing the judged tree AND the cwd in the block (`evaluated against <path> (cwd <cwd>)`) is still
the single highest-value line, and is what let this be measured in three tool calls.
