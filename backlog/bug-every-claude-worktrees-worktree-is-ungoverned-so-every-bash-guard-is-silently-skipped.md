# BUG: every `.claude/worktrees/*` worktree is UNGOVERNED — `pr-creation-or-push-guard`, `whole-repo-build-guard` and every other bash guard are silently skipped inside the sandbox agents are told to use

**Package:** `@webpieces/ai-hook-rules`
**Severity:** **HIGH** — this is a guard BYPASS, not a usability wart.
**Versions verified:** reproduced live on `0.4.614`; the code path is unchanged across `0.4.603`–`0.4.614`.
**Sibling defect:** see
`bug-a-reaped-worktree-reads-as-a-subdirectory-and-l1-prescribes-a-cd-into-the-deleted-path.md` —
same root cause (reasoning about worktrees by path shape instead of asking git).

**Source:** `packages/tooling/ai-hook-rules/src/core/effective-tree.ts`
- `:181-189` — `classify()` fast path
- `:213-217` — `isInside()` ("Pure path math, no filesystem")
- `:191-199` — `owningWorktree()` / the `'worktree'` tree kind

---

## What is wrong

`classify()` takes a fast path whenever the effective cwd is lexically inside the governed root:

```ts
// effective-tree.ts:184
if (this.isInside(effectiveCwd, governedRoot)) {
    const gitRoot = gitToplevel(effectiveCwd);
    if (gitRoot === null) return new TreeClassification('primary', governedRoot);
    if (path.resolve(gitRoot) === path.resolve(governedRoot)) return new TreeClassification('primary', governedRoot);
    return new TreeClassification('foreign', gitRoot);        // ← a linked worktree lands HERE
}

// :191 — "Outside the governed tree: is it a linked worktree of the SAME repo?"
const owner = this.owningWorktree(effectiveCwd, governedRoot);
if (owner !== null) return new TreeClassification(owner.isMain ? 'primary' : 'worktree', owner.path);
```

`isInside()` is pure path math with no filesystem access, and `EnterWorktree` creates worktrees at
`<governedRoot>/.claude/worktrees/<name>` — **lexically inside the governed root**. So the fast path
always wins and the `owningWorktree()` branch below it is **unreachable for the only worktree layout
the harness actually produces**. The `'worktree'` tree kind is effectively dead code.

Worse than mis-labelling: inside the fast path `gitToplevel()` returns the *worktree's own* toplevel
(that is what `git -C <worktree> rev-parse --show-toplevel` does), which is `!== governedRoot`, so the
tree classifies as **`foreign`** — and foreign trees are deliberately ungoverned ("each is its own
repo"). Every guard is therefore skipped.

## Repro (run live on `0.4.614`)

```bash
git worktree add --detach .claude/worktrees/probe-l1 HEAD
```

Same command, two locations:

```bash
# from the primary clone — correctly BLOCKED
cd /abs/path/webpieces-ts50 && git push --dry-run origin HEAD:refs/heads/dean/probe-guard-check
#   ❌ [pr-creation-or-push-guard] Manual push / direct PR is blocked — use the gated flow

# from the nested worktree — ALLOWED, the push executes
cd /abs/path/webpieces-ts50/.claude/worktrees/probe-l1 && git push --dry-run origin HEAD:refs/heads/dean/probe-guard-check
#   To personal:deanhiller/webpieces-ts.git
#    * [new branch]      HEAD -> dean/probe-guard-check
```

Only `--dry-run` kept that from being a real ungated push. An agent working in an `EnterWorktree`
worktree can push, open PRs by hand, and bypass the build gate freely.

This also silently defeats the sibling guards: `whole-repo-build-guard` does not fire there either, so
the very fault the `0.4.614` work was about is unenforced in exactly the sandbox agents are told to use.

**Practical impact observed:** an entire multi-agent session ran with every subagent in such a
worktree. All of them were ungoverned for the whole run.

## Fix

Resolve worktree ownership **before** the lexical fast path — a linked worktree is not a subdirectory
just because it happens to sit under the root on disk:

```ts
private classify(effectiveCwd: string, governedRoot: string): TreeClassification {
    // A linked worktree of THIS repo is its own governed tree, wherever it sits on disk —
    // .claude/worktrees/** is INSIDE the root, so this must precede the isInside() fast path.
    const owner = this.owningWorktree(effectiveCwd, governedRoot);
    if (owner !== null) return new TreeClassification(owner.isMain ? 'primary' : 'worktree', owner.path);

    if (this.isInside(effectiveCwd, governedRoot)) { … }   // unchanged
    …
}
```

Then decide deliberately what `'worktree'` MEANS to the guards. It must not mean "ungoverned": a
worktree of this repo pushes to this repo's remote and lands on this repo's `main`, so
`pr-creation-or-push-guard` and friends have to apply, judged against the worktree's own root and its
own `webpieces.config.json`.

`owningWorktree()` costs a `git worktree list`; if that is too expensive on the hot path, gate it on
`effectiveCwd` containing a `.git` **file** (the linked-worktree marker) rather than a directory.

## Test cases

1. cwd = `<root>/.claude/worktrees/wt`, command `git push …` → **BLOCKED** by
   `pr-creation-or-push-guard` (today: allowed). **This is the regression test that matters.**
2. cwd = `<root>/.claude/worktrees/wt`, command `pnpm run build-all` → blocked by
   `whole-repo-build-guard` when the home flag is on (today: not blocked).
3. cwd = `<root>/.claude/worktrees/wt`, command `git status` → allowed, judged against `wt`, tree kind
   `'worktree'` (not `'foreign'`).
4. cwd = `<root>/packages/http`, command `git status` → still blocked as a genuine subdirectory (no
   regression).
5. cwd = a genuinely foreign clone under `repositories/**` → still `'foreign'` and ungoverned (no
   regression).
