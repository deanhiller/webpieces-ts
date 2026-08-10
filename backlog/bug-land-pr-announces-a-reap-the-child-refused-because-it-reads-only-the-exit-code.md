> # ✅ RESOLVED — fixed **2026-08-10** by #635. Kept as a forensic record only.
>
> This report reproduced exactly as written, and was confirmed live: the fixing agent watched
> `pnpm wp-land-pr` (published `0.4.616`) announce `NO LONGER EXISTS` for its own worktree while the
> directory was still on disk — `pwd` succeeded immediately after.
>
> **The fix** ([#635](https://github.com/deanhiller/webpieces-ts/pull/635)) introduces a one-token
> stdout contract (`reap-outcome.ts`: `removed` / `refused` / `failed`, absent → `missing`). The child
> states an outcome on every exit path; the parent gates the "your cwd is gone" notice on that token
> rather than on the exit status, and an absent token reads as *still on disk* — the safe direction.
> The child still exits `0` on refusal, deliberately, for the reason §Source gives: exiting non-zero
> after a successful landing would report a landed PR as a failed command. That was never the defect —
> reading the exit code as the outcome was.
>
> **One correction to this report's field notes.** The refusal reason observed live read
> `locked by a human — do not touch`. That lock was **not** a human's: Claude Code's
> `isolation: "worktree"` locks an agent's worktree for the agent's lifetime and releases it on
> completion. Verified — while the agent ran, `git worktree list` showed `locked`; once it exited,
> `git worktree unlock` returned `fatal: … is not locked`. A follow-up should stop attributing a
> harness lock to a human, since the wording sends the reader looking for a person who does not exist.
>
> **Structural note worth keeping:** an agent can never reap its own worktree. It runs *inside* the
> tree, the harness holds that tree locked while it lives, and removal must run from the primary clone
> which the agent's isolation guard blocks. Both conditions clear only after the agent exits. Worktree
> reaping belongs to the coordinator, not the worker.

# BUG: `wp-land-pr` announces a reap the child **refused** — it reads only the exit code, and refusal exits 0

**Package:** `@webpieces/pr-gate`
**Version seen:** `0.4.616` (as pinned by a consuming repo; observed 2026-08-10)
**Severity:** Medium — no data loss, but the landing recap tells the operator two contradictory things
about their own shell, one of which is false. Seen **three times in one session**, from three
independent agents, so it is deterministic rather than a fluke.

**Source:**
- `packages/tooling/pr-gate/src/scripts/workflow/landed-worktree-reaper.ts:124-131` — `handOff()`
  branches on the child's **exit status only**, and on `0` unconditionally appends `afterReap()`.
- `packages/tooling/pr-gate/src/scripts/workflow/landed-worktree-reaper.ts:150-157` — `afterReap()`
  states as fact: *"`<path>` NO LONGER EXISTS — your shell is standing in a deleted directory"*.
- `packages/tooling/pr-gate/src/scripts/commands/reap-worktree-command.ts:60-85` — `resolveTarget()`
  returns `null` on **three** refusal paths (not a removable worktree / branch changed under us /
  `!target.deletable`), each printing a warning first.
- `packages/tooling/rules-config/src/merged-branches.ts:365` — the verdict that produced the refusal
  we hit: `'locked by a human — do not touch'`, `deletable: false`.

Related but **not** a duplicate:
[`bug-wp-cleanup-reaps-dead-branches-but-never-dead-worktrees-so-both-accumulate-forever`](./bug-wp-cleanup-reaps-dead-branches-but-never-dead-worktrees-so-both-accumulate-forever.md)
is "the reaper does not exist" at `0.4.492`. This is the *newer* reaper mis-reporting its own outcome.

## The contradiction, as an operator sees it

```
   ⚠️  /…/.claude/worktrees/agent-ab95a43e45a7716c3 is not provably dead:
       locked by a human — do not touch
       Refusing to remove a worktree that may still hold unmerged work.

   ⚠️  /…/.claude/worktrees/agent-ab95a43e45a7716c3 NO LONGER EXISTS — your shell is
       standing in a deleted directory, and every following command will fail until you move:
           cd '/…/monorepo-nx2'
```

Same path, same breath: *refusing to remove it* and *it no longer exists*. **The directory is still
there** — verified after the run, and the agents kept using it for post-merge verification.

## Root cause

A refusal is not an error, so `reap-worktree-command` prints its reason and exits **0**. `handOff()`
treats `status === 0` as "reaped":

```ts
if (result.status !== 0) {
    return head + output + '⚠️  The reap did not complete …' + this.manualNotice(handoff);
}
return head + output + this.afterReap(handoff);   // ← unconditional "NO LONGER EXISTS"
```

The child signals refusal **in-band** (prose on stdout, exit 0). The parent reads only the
**out-of-band** channel (exit code). The two never agree, and the parent's message is appended *after*
the child's, so the false claim gets the last word — exactly where a skimming reader stops.

## Why it matters more than cosmetics

`afterReap()`'s own doc comment says it exists because *"the shell they typed this into is now sitting
in a directory that no longer exists"*. That is precisely the belief it induces falsely here. The
operator is told to `cd` away from a live worktree that still holds their checkout — and in
`/full-cycle` runs the "operator" is an agent, which will believe it. One of the three sightings ended
with an agent reporting the worktree as both locked and deleted in the same handoff, leaving the human
to adjudicate.

## Fix

**Assert the postcondition; do not infer it.** `afterReap()` is a claim about the filesystem, so check
the filesystem:

```ts
if (result.status !== 0) { /* unchanged */ }
return head + (output !== '' ? output + '\n' : '')
    + (fs.existsSync(handoff.worktreePath) ? this.sparedNotice(handoff) : this.afterReap(handoff));
```

That is robust regardless of how the child chooses to signal, and it cannot drift when a fourth refusal
path is added to `resolveTarget()`.

Optionally *also* make the protocol explicit — a distinct exit code for "refused" (e.g. `2`), reserving
other non-zero values for genuine failure. Do that **in addition to**, not instead of, the `existsSync`
check: the exit-code contract is what just failed.

`sparedNotice()` should say the plain truth and name the cure already used elsewhere in this file:

```
   ℹ️  <path> was NOT removed — see the reason above. Your shell is still valid.
       To remove it yourself:  cd '<primary>' && pnpm wp-cleanup
```

## Tests

`landed-worktree-reaper.spec.ts:147-158` covers only the happy path — `childStdout = '  ✓ removed\n'`,
status 0 — and asserts `NO LONGER EXISTS`. Nothing exercises **exit 0 + refusal**, which is why this
shipped.

Add, in `describe('LandedWorktreeReaper — reporting what the child did')`:

1. **child refuses, exits 0, directory still present** → output does **not** contain `NO LONGER EXISTS`,
   does contain the child's refusal text, and points at `wp-cleanup`.
2. **child succeeds, directory gone** → unchanged; still contains `NO LONGER EXISTS` and the `cd`.
3. **child exits non-zero** → unchanged `manualNotice()` path.

Case 1 fails against today's code, which is the point.
