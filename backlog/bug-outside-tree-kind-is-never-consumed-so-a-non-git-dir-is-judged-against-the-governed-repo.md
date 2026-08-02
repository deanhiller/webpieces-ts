# `'outside'` tree kind is produced but never consumed, so a non-git directory is judged against the governed repo

## What happens

`TreeKind` has four values (`core/effective-tree.ts:40`):

```ts
export type TreeKind = 'primary' | 'worktree' | 'foreign' | 'outside';
```

`'outside'` is produced in exactly one place — and note which root it carries:

```ts
if (gitRoot === null) return new TreeClassification('outside', governedRoot);
```

Grep the package: **nothing ever branches on `'outside'`.** `runner.ts:290` branches on `'foreign'`
(→ allow, hands off) and that is the only `kind` test there is.

So a command whose effective cwd is in no git repo at all is handed to the main-sync guards carrying
`governedRoot`, and is judged against **the governed repo's branch, staleness and merge state** — a
repo it is not in. It can be blocked for "write on main" or "stale main" on the strength of another
tree's status.

## Expected

`'outside'` should be exempt, for the same reason `'foreign'` is: out of scope, hands off. It is the
weaker case of the two — `foreign` is at least *a* repo, `outside` is none.

## Why it survived

The guard-matrix doc records this row as *"defined kind, no branch of its own"* and hands it down to
L2, which described the code accurately but read as harmless. It isn't: "no branch of its own" plus
"carries `governedRoot`" means it silently inherits an unrelated repo's verdict.

## Fix

Branch on `'outside'` beside the `'foreign'` check in `runner.ts` — allow, log the exemption with its
own reason string so the two are distinguishable in `.webpieces/logs`, and cover both kinds in the L1
coverage test. Update the L1 row from `→ hand down to L2` to `exempt`.

## Related

Same family as `bug-bash-guards-judge-the-shell-cwd-not-the-paths-the-command-touches.md` — the
guards deciding jurisdiction from the wrong tree.
