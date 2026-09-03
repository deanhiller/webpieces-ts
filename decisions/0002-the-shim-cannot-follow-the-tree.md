# 0002 — The shim cannot follow the tree

**Status:** ⛔ **SUPERSEDED 2026-08-10 — the problem was ACCEPTED rather than solved.** This doc was
briefly "solved in principle" by [0003](0003-three-hooks-per-tree-governance.md); 0003 is now reversed.
**Raised:** 2026-08-06, while attempting D7 of [0001](0001-tree-identity-and-governance.md)
**Supersedes:** 0001 D7 (withdrawn)
**Superseded by:** the one-governor model — see 0003's superseded banner. Option A (the bridge) is DEAD,
killed by adversarial review; see 0003 §6 for the three confirmed kills. This doc remains the **problem
statement** and the record of what was rejected.

> ## ⛔ The answer, 2026-08-10: the shim cannot follow the tree, so nothing tries to
>
> §1's diagnosis is CORRECT and permanent, and 0003's relative-hook cure did not change it. Measured
> 2026-08-10: a linked worktree has no `node_modules`, so the relative shim's upward walk executed the
> MAIN tree's binary regardless — a worktree ran its own script and config but never its own release.
>
> So the model is now explicit rather than aspirational: **ONE governor per repo, the main tree's.**
> Both hooks are registered ABSOLUTE (`$CLAUDE_PROJECT_DIR/.claude/webpieces/ai-hook.sh`), the L-1 `cd`
> guard that the relative form required is deleted, and a worktree whose `@webpieces` pin disagrees with
> the main tree's is BLOCKED by L1 row 8 `trinary-version-skew` instead of being silently governed by a
> release it did not pin. A tree that genuinely needs its own release needs its own CLONE.
>
> The rest of this document stands as the measurement of why. The two-tree straddle it describes is
> real; the conclusion drawn from it has changed from "make the shim follow the tree" to "stop pretending
> it can, and block the skew".

> **Correction to §1.1 below.** `INVARIANT-1TREE` is stated too strongly. Where the shim and binary
> physically SIT does not matter; what matters is that the shim's logic and the running binary MATCH
> THE PIN OF THE TREE BEING JUDGED — `INVARIANT-1VERSION`. A nested worktree with no `node_modules`
> walking up to the primary's is fine when its pin equals the primary's installed version. But see
> 0003 §2.1: a mismatched binary can also write state in the wrong `shared()`/`local()` layout and
> **clobber another tree's state**, which is an independent reason to want the binary in the tree.

---

## 1. The problem

`.claude/settings.json` registers the PreToolUse hook as a **literal path**:

```
sh "$CLAUDE_PROJECT_DIR/.claude/webpieces/ai-hook.sh" <bin-name>
```

`$CLAUDE_PROJECT_DIR` is the **primary clone**, fixed at session start, for every agent — coordinator
and subagent alike, including a subagent bound to a linked worktree.

**The measurement.** Two reviewer subagents in the consuming repo `consumer-monorepo1`, 2026-08-06, each
bound to its own linked worktree. `root=` is resolved from the payload `cwd` and correctly tracks the
worktree; `projectDir=` is `$CLAUDE_PROJECT_DIR` and is pinned to the primary on **every** line:

```
root=…/consumer-monorepo1/.claude/worktrees/agent-aa2d06622008c7eb5   projectDir=…/consumer-monorepo1
root=…/consumer-monorepo1/.claude/worktrees/agent-ad0ce1739f5923910   projectDir=…/consumer-monorepo1
```

The same guard, in the same minute, gave the SAME agent opposite verdicts on the SAME target file —
because it judged the primary's branch, which an unrelated session moved:

```
06:21:09  ALLOW  Write  .webpieces/worktrees/agent-ad0ce…/pr-review/dean-one-2380-t8-docs/review-….json
                 dean/one-2376-t7-dataform   feature-branch-guard  clean-feature-branch   tree=primary
06:36:15  BLOCK  Write  .webpieces/worktrees/agent-ad0ce…/pr-review/dean-one-2380-t8-docs/review-….json
                 main                        feature-branch-guard  on-main                tree=primary
```

Read the branch column: `dean/one-2376-t7-dataform`, then `main`. **Neither is
`dean-one-2380-t8-docs`** — the branch under review, and the branch named in the very path being
written. The ALLOW was luck, not correctness. Both decisions were made against a tree the agent was
not standing in and could not change; every remedy the block offered was therefore unfollowable.

(Raw logs not committed — ~435 KB of another repo's traffic. The lines above are the whole of what was
ever cited, reproduced verbatim; the full block text the agent saw is quoted in
[#768](https://github.com/deanhiller/webpieces-ts/issues/768) §2.)

Therefore:

> **Every agent, in every tree, is governed by the PRIMARY clone's committed shim — forever.**
> A worktree can never receive different L0 logic, and a branch that upgrades `@webpieces` cannot
> take effect for the agent working on it.

### 1.1 Why the obvious fix is the incident we already had

The natural repair is "measure the effective tree instead of `$ROOT`" (0001 D7). It is wrong, and the
codebase already knows why. `packages/tooling/ai-hook-rules/src/bin/shim.ts:479-502`:

> *"Which tree supplies the binary? settings.json runs `$CLAUDE_PROJECT_DIR/.claude/webpieces/ai-hook.sh`,
> and that shim derives ROOT (hence BIN) from its own `$0` — so the SESSION ROOT's tree supplies BOTH
> the shim and the binary, and that pair is self-consistent by construction. A session rooted in a
> linked worktree runs the worktree's shim and the worktree's binary; that is fine and is NOT the bug.
> The straddle appears when an agent's SESSION ROOT and its CWD are different trees … Each tree carries
> its own node_modules at its own @webpieces version (seen in the wild: 0.4.545, 0.4.560 and 0.4.526
> side by side, every tree internally consistent). The comparison then straddles the two and can NEVER
> converge: curing in the cwd tree renders with THAT tree's `renderShim()`, which the running binary's
> `renderShim()` still rejects, so the cure re-fires the deny forever (observed: an agent gave up after
> four cures)."*

The invariant that comment protects, and that `governingShimRoot()` makes *unconstructible* rather
than merely discouraged:

> **INVARIANT-1TREE — the shim, the binary, and the `package.json` being measured must all come from
> ONE tree.**

D7 as written violates it deliberately: primary's shim, worktree's install. That is the straddle,
re-introduced. **This is the whole reason 0002 exists.**

### 1.2 What that means for a solution

Any fix must **re-root the entire hook at one tree**, not mix trees. It cannot "measure over here and
run over there". The question is therefore not *"how do we measure the worktree?"* but:

> **How does the hook get re-rooted at the effective tree BEFORE any version-specific logic runs?**

---

## 2. Constraints any solution must satisfy

| # | constraint | source |
|---|---|---|
| C1 | shim + binary + measured `package.json` come from one tree | `shim.ts:479-502`, INVARIANT-1TREE |
| C2 | a cure must always stay reachable — no state may deny its own fix | `.claude/rules/no-backwards-compat.md`, L0 allowlist design |
| C3 | works when there is **no** `node_modules` anywhere (fresh clone, brand-new sibling worktree) | fault X/U exists for exactly this |
| C4 | the committed hook entry point is a **checked-in file** that must match the running release, or fault S fires | `l0-matrix.ts` fault S |
| C5 | consumers run the **previous published release**; anything new must be adopted by a release *before* it can do anything | `.claude/rules/published-vs-local-source.md` |
| C6 | POSIX `sh` only at the entry point — no node, no bash-isms | the entry point runs before any install is proven |
| C7 | must not let an AI choose its own governing binary (that is disabling its own guards) | the guards exist to constrain the agent |

C4 + C5 together are the vice: **the entry point is the one file that cannot be upgraded per-tree,
and it is also the file that would have to change to make per-tree upgrades possible.**

---

## 3. Candidate solutions

None chosen. An adversarial review is running against these.

### Option A — Frozen trampoline (the "bridge")

The committed `.claude/webpieces/ai-hook.sh` becomes a ~20-line **stage 1** whose contract is frozen
forever. It resolves the effective tree, then `exec`s that tree's **stage 2** — the real shim, taken
from `<tree>/node_modules/@webpieces/ai-hook-rules/templates/ai-hook.sh`, with the tree root passed
explicitly (stage 2 can no longer derive `$ROOT` from `$0`, since it now lives under `node_modules`).

- Satisfies C1: after the `exec`, shim + binary + `package.json` are all that tree's.
- **Largely dissolves fault S**: stage 2 is the installed package's own file, so it cannot drift from
  the release by construction. Only the tiny stage 1 remains checked in.
- No recursion risk: stage 2 is not a trampoline, so there is nothing to loop on.
- Must still handle C3 itself — if no install is findable in any tree, stage 1 emits X/U with a
  **minimal frozen allowlist** of cure commands.
- **Main cost / main risk:** stage 1's contract is frozen. If it is wrong, every consumer holds a bad
  copy, and by C5 the fix arrives a release late. The frozen surface must be as small as it can
  possibly be, and the minimal allowlist inside it is the part most likely to need changing later
  (history shows allowlist entries get added).

### Option B — Refuse per-tree governance; block the divergence instead

Decide that a worktree may **not** run a different release from the primary. If the effective tree's
pin differs from the primary's, block with "upgrade the primary first".

- Trivially satisfies every constraint; no new machinery; INVARIANT-1TREE untouched.
- Honest about what is actually true today rather than pretending otherwise.
- **Cost:** kills the workflow of testing a `@webpieces` upgrade in a worktree — which is exactly the
  workflow that produced this whole investigation. Also needs care not to fire on the nested-worktree
  walk-up case (0001 §2.2), where a worktree *legitimately* has no install of its own.

### Option C — Empty the shim

Move all logic out of `sh` and into the binary, so the committed shim is a near-empty dispatcher that
almost never changes, and fault S almost never fires.

- Reduces the *frequency* of the problem without solving it: a near-empty shim still cannot be
  per-tree, and the drift check must stay in `sh` precisely because the binary cannot be trusted when
  it is the thing that drifted.
- Cheap, compatible with A, and probably worth doing regardless.

### Option D — Per-tree hook registration (the free fix, if it exists)

If Claude Code re-resolves `.claude/settings.json` from the worktree a subagent is bound to, the whole
problem evaporates: each tree registers its own hook, pointing at its own shim, and INVARIANT-1TREE
holds with no new machinery.

**Status: unknown, and worth an hour of empirical testing before building anything.** The official
docs do not specify whether project settings are re-resolved per subagent or fixed at session start
(checked 2026-08-06). Our own field evidence shows `$CLAUDE_PROJECT_DIR` does **not** move — but that
is a different question from whether *settings* are re-read.

**This is the highest-value unknown in this document.** If D is true, A is unnecessary.

### Option E — Deliberately do nothing about governance; fix only the observable damage

Ship the state/log relocation and the identity fixes, and leave version governance exactly as it is
(primary-anchored). Record the straddle as known and bounded.

---

## 4. Confirmed: the harness DOES give us agent identity

Answering the question directly, because it de-risks the separable half of this work.

**Yes.** The PreToolUse payload carries `agent_id` and `agent_type`, present **only** when the hook
fires inside a subagent (absent for the main agent — which was exactly how the since-deleted
`AgentIdentity.coordinator` was derived). Documented in the hooks reference, and already parsed:
`packages/tooling/ai-hook-rules/src/adapters/hook-core.ts`.

So **logging can be keyed per agent rather than per worktree today**, with no dependency on anything
in this document. That is still true and is what `LogStream` does.

> **But identity is trustworthy for NAMING A LOG FILE only — never for "which tree am I in"**
> (measured 2026-08-10, reproduced twice): a worktree-isolated agent whose tree is auto-reaped at a turn
> boundary silently resumes with its cwd on the primary clone, still carrying the same `agent_id`. That
> is why `CoordinatorWorktreeGuard` and L1's coordinator-in-worktree row are deleted, and why the L1
> matrix dimension `A` (coordinator/subagent) was replaced by `V` (versions in sync / skewed).

That matters because the two identities are otherwise conflated:

| identity | needed for | available? |
|---|---|---|
| effective **tree** | which release / which branch state governs | yes, but see §1 — the shim cannot act on it |
| calling **agent** | which log file to append to | **yes, cleanly** |

The 12-agent requirement (0001 §3) — 12 files, one place, timestamp-correlatable — depends only on
agent identity and on where state lives. It does **not** depend on solving §1.

---

## 5. Recommendation

**Split the work at the line §4 draws, and ship the half that is safe.**

1. **Now:** state/log relocation to `~/.webpieces/<flattened-primary-path>/`, keyed per agent
   (`logs/agents/<agentId>/`). Fixes the original reviewer-verdict bug structurally (a path outside
   the workspace never acquires guard jurisdiction), gives the 12-agent property, and touches no
   version governance. Note PR #579 already implements the per-agent half — coordinate rather than
   duplicate.
2. **Also now, because it is a prerequisite either way:** the `git rev-parse` normalisation fix
   (0001 §2.1). It is a genuine bug today and becomes load-bearing the moment paths key on the
   primary root.
3. **Before choosing between A / B / C:** empirically answer Option D. It is one experiment and it
   may delete the whole problem.
4. **Defer** per-tree version governance until D is answered. Do not re-open D7 without it.

---

## 6. Open questions

| # | question | why it matters |
|---|---|---|
| Q1 | Does Claude Code re-resolve `.claude/settings.json` from a subagent's worktree? | Option D; if yes, A is unnecessary |
| Q2 | Does `EnterWorktree` change `$CLAUDE_PROJECT_DIR` or settings resolution? | same |
| Q3 | Does `pnpm install` even work in a **nested** worktree inside the primary's pnpm workspace? | 0001 §2.2's cure assumes it does; untested |
| Q4 | If two nested worktrees share the primary's `node_modules` (0001 §2.2), does one agent's install change what another agent measures mid-flight? | concurrency of the D-fault |
| Q5 | Can the frozen stage-1 contract be made small enough to be genuinely freezable? | decides whether Option A is honest or wishful |
