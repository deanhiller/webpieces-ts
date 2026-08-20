> # ✅ RESOLVED — fixed by hard-coding the `.webpieces/` skip. Kept as the forensic record.
>
> `filterByExcludedPaths` (`ai-hook-rules/src/core/runner.ts`) now drops every rule for any path whose
> FIRST SEGMENT is `.webpieces`, **before** the `excludePaths` list is consulted — see
> `isWebpiecesStateDir` in `rules-config/src/exclude-hook-paths.ts`. The verdict path this report is
> about (`<primary>/.webpieces/worktrees/agent-＊/pr-review/…/review-＊.json`) therefore never reaches
> `FeatureBranchGuardRule.check()` at all, so there is no branch left to judge and no tree to resolve it
> against. That closes the whole class rather than this one path: `.webpieces/` is gitignored in every
> consumer, so nothing under it can reach a branch, be reviewed, be reverted, or be lost to a checkout,
> and every justification the branch-state guard prints there was vacuous.
>
> **Why the fix is not the config change this report proposed.** The consuming repo could already put
> `.webpieces/**` in its own `excludePaths` — and this repo had — but that leaves the exemption OPTIONAL
> on the one directory the TOOLING ITSELF asks an agent to write to, and `wp-install-ai-hooks` never
> rewrites an `excludePaths` array that already exists, so no seed would ever have reached an
> established repo. Hard-coding it fixes every consumer on the next pin bump. There is deliberately NO
> seeded glob — the skip is code only. `wp-install-ai-hooks` still seeds `excludePaths` EMPTY, because a
> `".webpieces/**"` entry would be a second and WEAKER spelling of the same decision: the glob matcher
> compiles it to an anchored regex that misses the bare `.webpieces` directory the predicate matches, and
> a config entry invites a consumer to delete it and believe the exemption went with it.
>
> **Still open, and deliberately not fixed here:** the underlying tree-resolution asymmetry this report
> diagnoses in §3 — a write judged against the primary clone's live branch — is untouched. It simply has
> no reachable trigger under `.webpieces/` any more. See also
> `bug-bash-guards-judge-the-shell-cwd-not-the-paths-the-command-touches.md`, which is why the Bash path
> is exempted by the shell's cwd rather than by the file the command names.

# BUG: feature-branch-guard judges a reviewer subagent's verdict write against the PRIMARY clone's live branch — the same write flips ALLOW→BLOCK as unrelated sessions move `main`

**Package:** `@webpieces/ai-hook-rules` (`FeatureBranchGuardRule`) + `@webpieces/pr-gate`
(the `pr-review/` artifact layout used by `wp-review-upsert-pr`)
**Version seen:** `@webpieces/*` **0.4.566** installed in the consuming repo; webpieces-ts at
`156b23b` (`Squash merge of guard/cd-must-be-first-and-literal`).
**Reporter context:** hit live **2026-08-06**, 06:21–07:16 UTC, in the consuming repo
`/Users/deanhiller/workspace/acme/consumer-monorepo1` (git `acme-internal/consumer-monorepo`). Two
independent `ticket-key-required` reviewer subagents hit it on two different tickets
(ONE-2380 and ONE-2383) in the same morning.
**Severity:** High — it blocks **every reviewer subagent on every PR** from writing the verdict file
the gate then reads, and it is **non-deterministic**: whether a given reviewer is blocked depends on
what branch an unrelated tree happens to be sitting on at that instant.

**Source:** `packages/tooling/ai-hook-rules/src/core/rules/feature-branch-guard.ts`
(`check()` → `this.currentBranch(ctx.workspaceRoot)`, State 1 `on-main`)

---

## 1. The mechanism, in one paragraph

A reviewer subagent runs bound to a linked worktree at
`<primary>/.claude/worktrees/agent-<id>` (on the feature branch under review), but `wp-review-upsert-pr`
places the artifacts it must write at `<primary>/.webpieces/worktrees/agent-<id>/pr-review/<branch>/`
— a path **inside the primary clone**. `FeatureBranchGuardRule.check()` resolves that write to
`tree=primary`, then calls `currentBranch(ctx.workspaceRoot)` against the **primary clone**. So the
guard's verdict is decided by whatever branch the primary working copy is checked out on *right now*
— a tree the subagent does not control, is not standing in, and which other sessions mutate
concurrently. When the primary happens to be on `main`, State 1 fires and the reviewer is told
*"You should not be working on main."*

The branch the guard actually reasons about is never the branch under review.

---

## 2. Proof: same agent, same file, opposite verdicts, 15 minutes apart

From `.webpieces/logs/guard-sync-decisions.log` in the consuming repo — lines 12 and 78. Both are the
**same reviewer subagent** (`agent-ad0ce1739f5923910`) writing the **same** verdict file for ticket
ONE-2380:

```
[06:21:09.130Z] ALLOW Write .webpieces/worktrees/agent-ad0ce1739f5923910/pr-review/dean-one-2380-t8-docs/review-ticket-key-required.json
                dean/one-2376-t7-dataform  feature-branch-guard  clean-feature-branch
                root=/Users/deanhiller/workspace/acme/consumer-monorepo1  tree=primary

[06:36:15.455Z] BLOCK Write .webpieces/worktrees/agent-ad0ce1739f5923910/pr-review/dean-one-2380-t8-docs/review-ticket-key-required.json
                main                       feature-branch-guard  on-main
                root=/Users/deanhiller/workspace/acme/consumer-monorepo1  tree=primary
```

Read the branch column. The write was allowed while the primary sat on `dean/one-2376-t7-dataform`,
and blocked once the primary moved to `main`. **Neither branch is `dean-one-2380-t8-docs`** — the
branch this reviewer was reviewing, and the branch named in the very path being written. The ALLOW
was not correct-and-then-regressed; it was luck. Both decisions were made against an unrelated tree.

`tree=primary` in both records is the crux: the write path lives under the primary clone even though
the agent is bound to `.claude/worktrees/agent-ad0ce1739f5923910`.

### The block the reviewer saw

`.webpieces/hooks/2026-08-06/writeInfo-1785998175519.md`:

```
❌ webpieces ai-hooks blocked this write: .webpieces/worktrees/agent-ad0ce1739f5923910/pr-review/dean-one-2380-t8-docs/review-ticket-key-required.json

[feature-branch-guard] (1 violation)
  L1: ...review-ticket-key-required.json
    → You should not be working on main.
Do a `git pull origin main` to get latest, then create a feature branch...
```

Every remedy offered is unfollowable: the subagent **is** on a clean feature branch, in a different
tree from the one the guard measured. There is no action it can take in its own worktree that changes
the primary clone's checkout, so the fix hint is unreachable by construction.

---

## 3. Reproduced independently on a second ticket

`agent-aa2d06622008c7eb5`, reviewing `dean/one-2383-upgrade-webpieces`, hit the same block ~40 minutes
later and reported it unprompted:

> `Write` refuses the verdict path with *"edit the worktree copy instead"*, though
> `…/.webpieces/worktrees/agent-aa2d06622008c7eb5/…` **is** this run's own worktree output dir — there
> is no `.webpieces/` inside the git worktree at all. I wrote via scratchpad + `cp` and validated the
> JSON parses.

Its own paraphrase of the message differs from the logged text, but the block and the workaround are
the same. That agent's `logs/guard-invocations.log` shows `Read` and `Bash` on the identical path both
resolving `root=…/.claude/worktrees/agent-aa2d06622008c7eb5` and returning `verdict=ALLOW` — so the
tree resolution is correct for those tools and wrong only for the file-scoped write path.

---

## 4. Four distinct defects, in priority order

**(a) The write is judged against the wrong tree.** `pr-gate` writes agent-scoped artifacts under
`<primary>/.webpieces/worktrees/agent-<id>/`, but the agent's git worktree is
`<primary>/.claude/worktrees/agent-<id>/`. Two different directory trees, both called "the worktree".
The guard resolves the former to `primary` and measures primary's branch.

**(b) It is a race on shared mutable state, not a stable false positive.** Primary's checked-out
branch is mutated by other sessions. Identical inputs give different verdicts minutes apart, so this
will read as flaky and be misdiagnosed. It also means a reviewer can pass on one run and block on a
rerun with nothing changed.

**(c) `.webpieces/**` has no exemption.** `FeatureBranchGuardRule` declares
`override readonly files = ['**/*']`, and the consuming repo's top-level `excludePaths` is
`["repositories/**", "tools/**"]`. So webpieces' own generated artifacts are gated by a rule about
whether *source code* is on a healthy branch. A verdict file is tooling output, not code — a
branch-state guard has no jurisdiction over it. Note this also bites **outside** worktrees: on
2026-07-28, `.webpieces/pr-review/feature-ONE-2201-grubhub-external-store-id/review.json` was blocked
by `feature-branch-guard` with no worktree involved (`.webpieces/logs/hook-rejection.log`).

**(d) The guard blocks the sanctioned tool and permits the workaround.** It is file-scoped, so
Write/Edit are gated but Bash passes through — deliberate, so recovery commands stay reachable. The
practical effect here is that `cp` from the scratchpad writes the exact same bytes to the exact same
path, unblocked (confirmed `verdict=ALLOW` in the agent's `guard-invocations.log`). The guard produces
friction without protection, and trains agents to route around it.

---

## 5. Why this is worse than the friction suggests

A reviewer whose verdict file never lands can be indistinguishable from a reviewer that never ran.
That is the failure already catalogued in
`backlog/bug-a-refused-reviewer-reads-as-one-that-never-ran-because-an-earlier-assert-masks-the-fail-message.md`
— this bug is a live, reproducible trigger for it. Both reviewers here recovered via `cp` and did
report GREEN, so no verdict was actually lost; a less persistent agent would have surfaced a required
checklist as missing, and `wp-finish-upsert-pr` verifies distinct reviewer runs.

It is also load-bearing for unattended flows. These two hits came from a fully autonomous
delegate-and-merge run, where a block that needs improvisation is exactly what the flow cannot absorb.

---

## 6. Suggested fixes (author's call)

1. **Resolve the artifact path to the owning agent's tree.** `.webpieces/worktrees/agent-<id>/…` is
   by construction agent-`<id>`'s output area; judge it against agent-`<id>`'s worktree, not primary.
   This is the targeted fix and preserves the guard's intent everywhere else.
2. **Or exempt `.webpieces/**` from `feature-branch-guard` outright.** Generated tooling state is
   never the thing the rule exists to protect, and this also fixes defect (c)'s non-worktree case.
3. **Or co-locate the artifacts** under the agent's actual git worktree so path and jurisdiction agree
   — larger change, but removes the two-directories-called-worktree ambiguity at the root.

Whatever the fix: a rule that cannot be satisfied from within the tree the agent is standing in should
probably not be able to block at all. If the guard ever measures a tree the caller cannot mutate, the
right verdict is fail-open, consistent with the existing `branch-undeterminable` and
`no-sync-cache` paths.

---

## 7. Minor, possibly unrelated observation

The consuming repo has a directory literally named `.git` in the agent-artifact namespace:

```
.webpieces/worktrees/.git/logs/ai-hook-shim.log
```

created 2026-08-06 09:07 local, sibling to the two real `agent-<id>` entries. Something derived a
tree name of `.git` and used it as a directory key. Harmless-looking, but it suggests the same
tree-naming path that produces `tree=primary` above can yield a degenerate name. Not investigated.

---

## 8. Evidence locations

All in the consuming repo `/Users/deanhiller/workspace/acme/consumer-monorepo1`:

| What | Path |
|---|---|
| ALLOW/BLOCK decision records (§2) | `.webpieces/logs/guard-sync-decisions.log` lines 12, 78, 79 |
| Rejection index | `.webpieces/logs/hook-rejection.log` (last line; plus the 2026-07-28 non-worktree case) |
| Full block text + the JSON that was refused | `.webpieces/hooks/2026-08-06/writeInfo-1785998175519.md` |
| Per-agent invocation log, ONE-2383 reviewer | `.webpieces/worktrees/agent-aa2d06622008c7eb5/logs/guard-invocations.log` lines 30, 33 |
| Per-agent logs, ONE-2380 reviewer | `.webpieces/worktrees/agent-ad0ce1739f5923910/logs/` |
| Shim log | `.webpieces/logs/ai-hook-shim.log` |

**Committed form (2026-08-06):** none of these files are committed. They were ~435 KB of another repo's
traffic and only a handful of lines were ever cited. Those lines are reproduced verbatim in
[`decisions/0002`](../decisions/0002-the-shim-cannot-follow-the-tree.md) §1, next to the conclusion they
support — which is where a reader needs them, rather than in a parallel evidence tree nobody greps. The
block message itself is quoted in §2 above. The originals are local-only and will be overwritten by
continued work in that repo.
