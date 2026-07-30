# FEATURE: archive a deleted branch as a git tag instead of keeping `*PreMerge` branches, and split `merge-info` into `staged/` and `merged/`

**Package:** `@webpieces/pr-gate` (land + cleanup), `@webpieces/ai-hook-rules` (`wp-cleanup`)
**Version seen:** `0.4.490`
**Severity:** Medium — no wrong results. Two ergonomics problems that compound: pre-merge branches
accumulate until `branch-creation-guard` trips, and `merge-info` interleaves in-flight and landed state
with a placeholder file in every clean directory.

**Source:** `.webpieces/merge-info/{branch}/merge-N/` layout; `wp-cleanup` sparing logic;
`wp-land-pr` post-merge step.

Depends on nothing; pairs with
[`bug-tree-recovery-forbids-git-checkout-main-in-the-primary-clone-where-it-is-the-easy-exit`](./bug-tree-recovery-forbids-git-checkout-main-in-the-primary-clone-where-it-is-the-easy-exit.md)
— branch accumulation is what makes that trap reachable.

## Part 1 — tag the tip, then delete the branch

`*PreMerge` branches exist for a real reason: after a squash merge you sometimes need the original
pre-merge history to debug. The current answer is to keep the branch, so they accumulate forever. In
`mealco-internal/monorepo-nx` this reached 6 parked branches against a cap of 5 and wedged a session.

A tag solves the same problem strictly better. Verified by hand:

```bash
git tag archive/2026-07-30/dean/webpieces-0-3-322 dean/webpieces-0-3-322
git branch -D dean/webpieces-0-3-322
# fully restorable, exact objects:
git checkout -b dean/webpieces-0-3-322 archive/2026-07-30/dean/webpieces-0-3-322
```

- **vs keeping the branch** — invisible to `git branch`, does not count toward `maxLocalBranches`,
  cannot be accidentally committed onto.
- **vs storing a patch in `merge-info`** — a patch is lossy: it drops commit boundaries, messages,
  authorship, parentage. A tag preserves the objects exactly.
- **vs relying on reflog** — reflog expires (90 days) and is local to the clone that did the work. A tag
  survives `gc` and can be pushed if durability beyond one machine is wanted.

Cost: one ref, zero new objects.

**Ask:** on `wp-land-pr`, and on `wp-cleanup` deleting a stray, tag before deleting. Config:

```jsonc
"landPr": { "branchRetention": "archive-tag" }   // "delete" | "archive-tag" | "keep"
```

Record every pre-merge tip as it happens, so a branch updated from main several times keeps each
intermediate state rather than only the last:

```
.webpieces/merge-info/staged/{branch}/preMerge1.hash
.webpieces/merge-info/staged/{branch}/preMerge2.hash
```

## Part 2 — delete `no-3point-merge.md`

```
.webpieces/merge-info/feature-ONE-webpieces-0-3-375/merge-1/
    no-3point-merge.md      updatemain-hashes.json
```

A file whose entire content is "nothing interesting happened here" is noise in every directory a human
opens. **Absence should be the signal**: write a conflict artifact when the merge was 3-point, write
nothing when it was clean. Then "does this directory contain a conflict file?" is the whole question.

## Part 3 — split in-flight from landed

Goal: opening `merge-info` should immediately show which merges are worth reviewing. Encoding that in the
branch directory name does **not** work, because one branch can alternate clean -> 3-point -> clean ->
3-point. So put the axis on the merge, not the branch:

```
.webpieces/merge-info/
  staged/{branch}/                  # in-flight only; mirrors branches that still exist
      merge-1/updatemain-hashes.json
      merge-2/updatemain-hashes.json
      merge-2/conflicts.md          # present ONLY when this merge was 3-point
      preMerge1.hash
      preMerge2.hash
  merged/{branch}/                  # moved here wholesale when the PR lands
      merge-1/…
      merge-2/…
      archive.json                  # { archiveTag, tipSha, baseSha, pr, mergedAt }
```

`staged/` then answers "what am I working on right now" and self-cleans on land instead of growing
forever. `merged/` is the post-mortem record, and is where the archive tag reference lives.

## Part 4 — an index, because branches alternate

Since a single branch can mix clean and 3-point merges, directory naming cannot carry the distinction.
Emit an index instead:

```jsonc
// .webpieces/merge-info/index.json
{
  "merged": {
    "feature-ONE-webpieces-0-3-375": {
      "pr": 375,
      "archiveTag": "archive/2026-07-30/feature/ONE-webpieces-0-3-375",
      "merges": [
        { "n": 1, "threeWay": false },
        { "n": 2, "threeWay": true, "conflicts": ["src/a.ts", "src/b.ts"] }
      ]
    }
  }
}
```

One `jq` then lists every 3-point merge across all branches — the actual review question — and stays
correct for branches that alternate.

## Part 5 — `wp-cleanup` should classify and prompt, not spare silently

Every spared branch currently reports the same string: `no merged PR found — a human must decide`. In one
repo that covered three genuinely different situations:

| Branch | Actual state |
|---|---|
| `feature/ONE-2209-morpheus-gate` | PR #752 **closed unmerged** — superseded by #754 |
| `feature/ONE-2209-morpheus-every-pr` | PR #740 **closed unmerged** — superseded by #749 |
| `dean/webpieces-0-3-322` | **never had a PR**; 3 unmerged commits, 200 behind main |
| `dean/fix-cd-checklist-docs-missing-in-container` | **never had a PR**; 3 unmerged commits |
| `dean/ONE-1787-…-auditPreMerge` / `…-auditwp2` | **never had a PR** |

"Superseded by a merged PR" is near-certainly safe to delete. "Never proposed, holds unique commits" may
be the only copy in existence. Reporting both identically — then sparing rather than asking — guarantees
the pile grows until a guard trips.

**Ask:** classify as `superseded` / `never-proposed` / `content-already-in-main`, show the unique-commit
count, and prompt. With Part 1 in place the prompt is low-stakes, because deleting archives first.
