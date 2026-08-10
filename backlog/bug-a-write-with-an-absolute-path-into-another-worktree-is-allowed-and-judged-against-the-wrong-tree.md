# BUG: a Write/Edit with an ABSOLUTE path into another worktree is allowed, and every rule is judged against the WRONG tree

**Package:** `@webpieces/ai-hook-rules` (and `@webpieces/code-rules`, which supplies the rules being
mis-applied)
**Severity:** **HIGH** — it is silent. Nothing blocks, nothing warns, and the log line says `tree=primary`
while the bytes land in a worktree. This is the filesystem/governance split that L1's
`CoordinatorWorktreeGuard` exists to prevent, reached by a route that guard never sees.
**Versions verified:** reproduced live on `0.4.616` (harness: Claude Code, Opus 5), 2026-08-10.

**Sibling defect:** [`bug-feature-branch-guard-judges-a-subagent-verdict-write-against-the-primary-clones-live-branch`](./bug-feature-branch-guard-judges-a-subagent-verdict-write-against-the-primary-clones-live-branch.md)
— same root cause (a Write judged against the wrong tree), narrower symptom.

---

## In one paragraph

> Every bash guard reasons about *which tree a command acts on* — `EffectiveTreeResolver` exists for
> exactly that, and L1 blocks the coordinator when the answer is "a linked worktree". The file tools do
> no such thing. A `Write` names an absolute path, the path can be in any tree, and the hook judges it
> against the tree the *shell* is in. So the one tool that can modify another tree with no `cd` at all is
> the one tool that never asks which tree it is modifying.

## Observed live

An ORDINARY subagent, cwd = the primary clone, wrote into a linked worktree by absolute path:

```
Write  /Users/…/webpieces-ts50/.claude/worktrees/wp-cd-probe/probe-scratch.txt
→ File created successfully.        (no block, no warning)
```

The L0 audit line for that call:

```
2026-08-10T16:59:32+0300  wp-ai-guards-hook  Write  tree=primary  fault=-  PASS-BIN-ALLOW
```

`tree=primary` — but the bytes landed in `wp-cd-probe`. Note also the command field is EMPTY for Write,
so the log does not even record which path was written; the tree is the only locational field and it is
wrong.

## Why this is worse than the coordinator `cd` case L1 already blocks

`cd <worktree> && <cmd>` is at least *visible*: it names the worktree in the command string,
`EffectiveTreeResolver` resolves it, L-1 audits it, and L1 blocks the coordinator outright. A Write has
none of that:

| | `cd <wt> && cmd` | `Write <wt>/file` |
|---|---|---|
| names the target tree in a way a guard parses | yes (`effectiveCwd`) | **no** |
| L-1 sees it | yes (Bash only) | **no — L-1 is registered for Bash alone** |
| L1 coordinator guard sees it | yes → BLOCK | **no** |
| audit log records the location | `dest=` + `cwd=` | `tree=` only, and it is wrong |

L-1 is registered for Bash alone *on purpose* — "no other tool can move the shell" — and that reasoning
is correct for its own job. It is not a location guard for file tools, and nothing else is either.

## What is actually mis-judged

`runFileTool`/`handleFileTool` resolve the workspace root from the payload `cwd`
(`RepoRootFinder.resolveRepoRoot(cwd)`), then compute `path.relative(workspaceRoot, input.filePath)` and
match rules on that relative path. When the file is in a different tree, that relative path is a `../..`
escape string, so:

- **`excludePaths` and every rule's `allowedPaths` are matched against a nonsense path**, which means a
  rule can silently fail to apply, or apply where it should not;
- **the branch-aware guards read the WRONG branch.** `feature-branch-guard` and `read-stale-guard` ask
  "what branch is this tree on"— and get the primary's answer for a file in a worktree that is on a
  different branch entirely. That is the sibling bug already filed, and this is its general form;
- **the config that governs is the wrong one.** `webpieces.config.json` is TRACKED and therefore
  per-branch by design (`state-dir.ts` is explicit that config stays per-worktree). A worktree may
  legitimately have different rules; a Write into it is judged by the primary's.

## Fix

1. **Resolve the tree from the FILE PATH, not the shell cwd, for every file tool.** The primitive
   already exists and is already the authority for this question — `dotWebpieces.treeRoot(dirname(filePath))`
   and `dotWebpieces.gitDirs(...)`, which is exactly how `EffectiveTreeResolver.classify` decides tree
   identity for Bash. Use the same answer for Write/Edit/MultiEdit so the two halves cannot disagree.
2. **Then apply the existing verdicts to it.** With the correct tree in hand this becomes the case the
   guards already handle: a `foreign` tree is out of scope (hands off), a `worktree` tree for the
   COORDINATOR is the L1 block that already exists, and `primary` is unchanged. The point is to route
   the file tools through the classification, not to invent a new policy.
3. **Log the path.** The Write log line currently has an empty command field, so a mis-attributed write
   leaves no forensic trail at all. Record the target path (or at least its resolved tree) the way the
   Bash line records `dest=`.
4. **Decide the subagent case deliberately.** A worktree-isolated subagent writing into its OWN worktree
   must stay allowed — that is the supported pattern and it is the common case. The rule is therefore
   "the file's tree must be the tree that governs THIS agent", not "no cross-tree writes ever".

## Worth stating plainly

An existing worktree can be **ACTED ON** but never **STOOD IN** (see
[`bug-l1-prescribes-a-subagent-remedy-that-cannot-be-launched-and-would-not-fix-the-governance-split-anyway`](./bug-l1-prescribes-a-subagent-remedy-that-cannot-be-launched-and-would-not-fix-the-governance-split-anyway.md)).
Since acting-on is the *only* available mode, absolute-path file writes into another tree are not an edge
case to be stamped out — they are the normal way work reaches a worktree. That is precisely why they need
to be judged against the right tree rather than blocked.
