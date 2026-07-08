# Merge tools — why a 3-point merge

* A three point merge involves A (fork point), B (head of feature branch), C (head of main branch).
* git does a 2-point merge and IDEs try to simulate a 3-point merge on top of that. PROOF: the file only
  has B and C, not the A code.
* Humans and AI can do a far better job merging with a 3-point merge, because **B-A** and **C-A** show
  the *intent* of each branch (what the feature changed vs. what main changed since the fork).
* Basically, all developers should be doing a squashed rebase (`git merge --squash` replays all your
  commits as a single commit onto a fresh base).

```
          A (fork point)
         / \
        /   \
       B     C
   (feature) (main)

B-A.diff = what the developer changed on the feature branch
C-A.diff = what changed on main since the branch forked
```

For a clean 3-point merge to be possible, one of these must hold (else you must first deal with getting
main mergeable):
1. every previous update from main into the feature branch was itself a 3-point squash-update, OR
2. a `git merge --squash` back onto fresh main is CLEAN.

## How to actually run it (automated)

You do **not** run the fork-point/backup/squash steps by hand anymore — the `@webpieces/pr-gate`
commands do all of it (worktree-safe), and they record the 3-point context for you:

```bash
pnpm wp-start-update      # standalone update from main (no PR); or pnpm wp-start-upsert-pr for the PR flow
# clean   → finalizes automatically
# conflict → the tool writes A/B/C context + per-file B-A.diff / C-A.diff under
#            .webpieces/merge-info/<slug>/merge-<n>/ and hands resolution to you:
/wp-merge                 # resolve each conflicted file using the A/B/C context
pnpm wp-finish-update     # finalize (standalone); in the PR flow run pnpm wp-finish-upsert-pr instead
```

The tool takes a pre-merge snapshot branch and, on a clean merge, force-pushes and renames back to your
feature branch so local / `origin/<feature>` / PR head always share one name.

The authoritative, always-current step-by-step lives at
`.webpieces/instruct-ai/webpieces.git-workflow.md` (regenerated on every `wp-*` command). See also
`docs/git-workflow.md`.
