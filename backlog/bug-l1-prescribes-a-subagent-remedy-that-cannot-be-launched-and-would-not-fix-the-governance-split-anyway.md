> # ✅ VALIDATED then FIXED — re-measured live **2026-08-10** on `0.4.616`, then fixed in this PR.
>
> Every claim in this report was re-tested empirically with three probe subagents rather than argued
> from the source. **The report is correct.** Two of its statements needed correcting, and both make the
> situation worse, not better.
>
> ## Confirmed as written
>
> - **Defect 1a — `Agent(isolation:"worktree")` cannot target an existing worktree.** Confirmed from the
>   tool schema: the only isolation values are `"worktree"` and `"remote"`, and there is no path
>   parameter. It always creates a fresh tree under `<primary>/.claude/worktrees/agent-<id>` and git-locks
>   it for the agent's lifetime.
> - **Defect 1b — `EnterWorktree` is unreachable from a subagent.** Measured twice, byte-identical
>   refusals: *"Cannot enter worktree: the current working directory … is the repository root, not an
>   isolated worktree."* Tested against BOTH a sibling worktree and one under `.claude/worktrees/`, both
>   registered in `git worktree list` — so **the target's location is not the discriminator**; the refusal
>   fires on `cwd == repo root` before any path check. The prescription is circular exactly as reported.
>   (Note the tool's own description documents "on first entry from the launch directory, the path must
>   appear in `git worktree list`" as supported. The runtime does not honour it. That mismatch is upstream
>   of webpieces.)
> - **Fix item 4 — the invariant does not cover this remedy.** Confirmed structurally:
>   `effective-tree.spec.ts`'s `suggestedCommand()` extracts only lines matching `/^\s+cd '/`, so a remedy
>   made of prose naming tool calls can never be fed back through the runner. The property test *cannot*
>   reach this guard, rather than merely happening not to.
>
> ## Correction 1 — the report's blessed escape is ALSO mis-anchored
>
> §"Defect 2" ends by inferring that `Agent(isolation:"worktree")` "genuinely binds governance to the
> worktree". **Measured: it binds only half of it.**
>
> | layer | wiring | which tree actually governs |
> |---|---|---|
> | `ai-hook.sh` (L0/L1) | `sh ".claude/webpieces/ai-hook.sh"` — RELATIVE | ✅ the **worktree's** own copy |
> | `guarantee-root.sh` (L-1) | `sh "$CLAUDE_PROJECT_DIR/.claude/webpieces/guarantee-root.sh"` — ABSOLUTE | ❌ always the **primary clone's** |
> | `$CLAUDE_PROJECT_DIR`, all `.webpieces/` writes | — | ❌ always the **primary clone** |
>
> So delegation NARROWS the split; it never closes it. This is by design and is not itself a defect —
> `guarantee-root.sh` is the bootstrap that makes the relative path resolvable, so it is the one file that
> cannot be per-tree (see its own header). But it means the report understated the problem: there was no
> fully-anchored launch to fall back to.
>
> ## Correction 2 — `cd` into a worktree is allowed, and does NOT persist
>
> A fourth escape the report did not consider: an ordinary subagent `cd`-ing into an existing worktree.
> L-1 allows it (`ALLOW-GIT-TREE`, since a worktree root holds a `.git` file) — **but it does not stick.**
> Measured: after `cd <worktree>`, the next tool call's `pwd` was back at the primary and
> `git rev-parse --abbrev-ref HEAD` reported the *primary's* branch.
>
> This contradicts a load-bearing premise stated in both `effective-tree.ts` and L-1's own deny text —
> *"a `cd` that stays INSIDE the workspace PERSISTS to your next call"* — for a destination that is
> inside the workspace. **Filed as its own follow-up**; one measurement is not enough to rewrite a layer,
> and it is awkward to test further because every non-root destination is denied by L-1 anyway.
>
> Net: an existing worktree can be **ACTED ON** (`git -C`, `pnpm -C`, or `cd <wt> && <cmd>` per command,
> where the `cd` binds within that single command) but never **STOOD IN**.
>
> ## Also found: a live deadlock, worse than the reported one
>
> A worktree-isolated subagent ran `cd <its own worktree>/packages`. That path is inside
> `$CLAUDE_PROJECT_DIR` (agent worktrees live under the primary) and holds no `.git`, so L-1 TEST 3 fired
> and prescribed `cd <primary clone>` — which **the harness then refused**, because an isolated agent may
> not cd to the shared checkout. The agent could neither stay nor follow the cure. Both halves are in this
> repo's own logs:
>
> ```
> ALLOW-GIT-TREE  dest=…/webpieces-ts50                    cwd=…/agent-a5758c696966ca418
> DENY            dest=…/agent-a5758c696966ca418/packages  cwd=…/agent-a5758c696966ca418
> ```
>
> ## What this PR changed
>
> 1. **L-1 now prescribes the destination's OWN tree root** — the nearest ancestor holding a `.git`,
>    found by walking up — instead of `$CLAUDE_PROJECT_DIR`. For a path inside a worktree that is the
>    WORKTREE root, which is both where the relative hook beside it lives and a tree an isolated agent is
>    allowed to stand in. Kills the deadlock. Unchanged for primary-clone paths.
> 2. **The L1 message stops prescribing what cannot be done** (report's fix item 2). It now names the
>    reachable moves and states the three dead ends outright, so an agent does not re-derive them by
>    burning turns — which is what the live incident did.
> 3. **Both sh layers now record which copy of themselves ran.** L-1's cd-audit line gains `shim=`
>    (its own root, from `$0`); L0's shim line gains `shim=` AND `bin=` (`$ROOT` and `$BIN_ROOT` — the
>    script's tree and the tree the upward walk borrowed the binary from). Previously *no* log at any
>    layer recorded any of this — L-1 and L0 logged neither `$0` nor their root, and only L1 logged
>    `root=`/`projectDir=` — so "which hook governed this call" had to be established by inference.
>    `shim=` vs `bin=` now shows a borrow directly, and either against the tree shows a straddle.
> 4. **The generated `guards/L1-location.md` and the L1 matrix row** no longer teach the refuted premise.
>
> **Still open, deliberately:** fix item 1 (making an existing worktree launchable) is a harness change,
> not a webpieces one. Fix item 4 (extending the property test to tool-call remedies) is not done.

# BUG: L1 `coordinator-worktree` prescribes a remedy that (a) cannot be launched for an EXISTING worktree and (b) would not move the governance anchor even if it could

**Package:** `@webpieces/ai-hook-rules`
**Severity:** **HIGH** — hard deadlock with no in-band recovery, *and* the prescription is unsound on
its own terms. An agent that follows the message literally ends up mis-governed rather than governed.
**Versions verified:** reproduced live on `0.4.616` (harness: Claude Code, Opus 5).
**Sibling defects:** `bug-a-reaped-worktree-reads-as-a-subdirectory-and-l1-prescribes-a-cd-into-the-deleted-path.md`
and `bug-every-claude-worktrees-worktree-is-ungoverned-so-every-bash-guard-is-silently-skipped.md`.
Both are about *classifying* a tree. This one is about the *remedy* L1 prints once it has classified
correctly — L1 fired exactly as designed here.

**Source:** `packages/tooling/ai-hook-rules/src/core/coordinator-worktree.js` (shipped
`node_modules/@webpieces/ai-hook-rules/src/core/coordinator-worktree.js`)
- `:79-91` — `report()`, the message
- `:85-86` — the two prescribed remedies

---

## In one paragraph

> Spawning a subagent doesn't close the split L1 exists to prevent — it just relocates it to a
> different agent. The only thing that actually binds governance to the worktree is launching the
> agent with its project dir already there, which is what `Agent(isolation:"worktree")` does — and
> that can only create a **new** worktree.

So for an existing worktree there is no correct move at all: the reachable launch (`isolation:
"worktree"`) cannot target it, and the launch that can reach it (an ordinary subagent, then
`EnterWorktree`) is both refused and — were it allowed — still mis-anchored.

---

## What is wrong

L1 is right to block. The header comment on this rule documents the incident it exists for: the
coordinator's `$CLAUDE_PROJECT_DIR` is fixed at session start and does not follow a `cd`, so a
coordinator working inside a linked worktree has its filesystem in one tree and its governance in
another — the five-no-op-install failure.

The block is correct. **The remedy is not reachable, and it does not do what the rule wants.**

`report()` prints two escapes:

```js
'   Spawn a subagent bound to that worktree and work through it: the Agent tool with worktree',
`   isolation, or have the subagent call EnterWorktree with path: ${tree.root}`,
```

### Defect 1 — neither escape can attach to an EXISTING worktree

- **`Agent(isolation: "worktree")` *creates* a new worktree.** It has no parameter naming an existing
  path. So it cannot be used to work in a worktree the coordinator deliberately placed at a chosen
  commit — which is the entire reason to have made one by hand.
- **`EnterWorktree` refuses from the repo root.** A subagent inherits the coordinator's cwd, which is
  the repo root, so it can never satisfy the precondition:

  ```
  Cannot enter worktree: the current working directory <primary> is the repository root,
  not an isolated worktree — switching is only available to sessions whose working directory
  is inside a worktree of this repository.
  ```

  To enter a worktree you must already be in one. The prescription is circular.

With both escapes closed, the subagent's only remaining move is the very `cd <worktree> && …` that L1
blocked the coordinator from — i.e. the message routes the agent straight back into the forbidden
action, one indirection later.

### Defect 2 — the deeper one: a spawned subagent does not move the governance anchor

This is what makes the message unsound rather than merely unreachable.

Verified in this repo: a linked worktree carries its **own** governance — its own
`.claude/settings.json`, its own `.claude/webpieces/ai-hook.sh`, and its own
`node_modules/@webpieces/ai-hook-rules`. That is the stated design ("the guard hooks beside it are
registered RELATIVE, so that each git tree is governed by its own @webpieces release" —
`guarantee-root.sh` header). Two trees can therefore be on two different `@webpieces` releases, which
is exactly the drift L0 measures.

But `$CLAUDE_PROJECT_DIR` is fixed at session start and is **inherited by a spawned subagent**. A
subagent spawned by a coordinator whose project dir is the primary clone is *also* anchored to the
primary clone. `guarantee-root.sh` is registered ABSOLUTE against `$CLAUDE_PROJECT_DIR`, and the L0
version measurement is taken against the governed root — so the subagent reads the **maintree's**
settings and measures the **maintree's** pin, while its filesystem work happens in the worktree.

That is the same filesystem/governance split L1 exists to prevent. Spawning a subagent does not fix
it; it relocates it to another agent, where it is harder to notice.

The only launch that genuinely binds governance to the worktree is one where the agent's project dir
*starts* inside it — which is what `Agent(isolation: "worktree")` does, and why that escape works
while `EnterWorktree`-after-the-fact does not. (Inference, from the observed behaviour of a worktree
subagent whose Write guard was scoped to `<primary>/.webpieces/worktrees/<agent>/…`; I cannot see the
harness's settings-resolution code.)

## Observed live (`0.4.616`)

Coordinator created a worktree at a specific SHA to pin a dev deploy, then tried to run in it:

```
git worktree add ../dean-dev-soak-29d255b -b dean/dev-soak-29d255b origin/main   # ok
cd /Users/…/dean-dev-soak-29d255b && pnpm wp-push-dev
```

L1 fired (correct):

```
❌ You are the COORDINATOR and this command works inside linked worktree /Users/…/dean-dev-soak-29d255b.
   Your governance is anchored to /Users/…/monorepo-nx1 and does NOT follow a `cd`, so working
   here splits your filesystem from your guards — the failure that burned five no-op installs.

   Spawn a subagent bound to that worktree and work through it: the Agent tool with worktree
   isolation, or have the subagent call EnterWorktree with path: /Users/…/dean-dev-soak-29d255b
```

The coordinator followed it exactly — spawned a subagent, instructed it to `EnterWorktree` at that
path. Subagent transcript (`agent-a4117724341835cec.jsonl`, steps #6/#7 and #12/#13): `EnterWorktree`
refused **twice** with the repo-root error above. At step #18 the subagent fell back to
`cd <worktree> && pnpm wp-push-dev` — the forbidden command — and the human killed the session.

Net: no supported path exists for *"place a worktree at SHA X, then get work done in it."*

## Fix

1. **Make an existing worktree launchable.** Either an `Agent` option that binds to a given path
   (`isolation: "worktree", worktreePath: <root>`), or let `EnterWorktree` be called by a subagent
   whose cwd is the repo root — with the harness re-resolving `$CLAUDE_PROJECT_DIR`/settings to the
   worktree, since a cwd move that leaves governance behind is the bug, not the fix.

2. **Until (1) exists, stop prescribing what cannot be done.** If the rule cannot name a reachable
   remedy for an existing worktree, it should say so and prescribe the two things that DO work:
   - do the work in the primary clone (`git -C`, or check the branch out in the primary tree), or
   - let the human run it in the worktree, outside the agent's guards.

3. **Name the real failure when a subagent arrives mis-anchored.** Per the reporting human: if a
   subagent's `$CLAUDE_PROJECT_DIR` does not match the tree it is being asked to work in, the block
   should tell the *coordinator* that it launched the agent wrong — not tell the subagent to `cd`.
   The subagent cannot fix its own anchor; only the launch can.

4. **Apply the existing invariant to L1's own message.** `effective-tree.spec.ts` already feeds every
   L1 block's printed remedy back through the runner and asserts it does not re-trigger the guard
   that printed it (shipped with the reaped-worktree fix). That property does not cover a remedy
   addressed to a *different agent*: here the coordinator's remedy re-triggers the same rule inside
   the subagent. Extend the property to remedies that name a tool call rather than a shell command.

## Related

`feature-share-webpieces-state-across-worktrees-with-a-scoped-resolver.md` — adjacent, but that is
about sharing state between trees. This is about being able to launch into one at all.
