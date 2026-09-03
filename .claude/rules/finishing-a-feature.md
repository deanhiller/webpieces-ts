# Finishing a feature: the gated PR flow and cleanup

Moved verbatim out of `CLAUDE.md`. Read this when the code is written and you are about to post the PR,
when you are landing one, or when you are cleaning up branches and worktrees afterwards.

## Finishing a Feature (CRITICAL)

**RULE: Finishing a feature MEANS posting the PR. They are the same step, not two.**

When the code is written, tests pass, and the affected build is green, your **very next action is to post the
PR** — do NOT end your turn with "want me to open a PR?" That question is already answered: **yes,
always.** Commit your work (the tooling never commits for you), then run the gated flow:

```bash
pnpm wp-start-upsert-pr        # ① 3-point update from main
pnpm wp-review-upsert-pr       # ② validates that merge, BUILDS it, extracts the diff, briefs the reviewers
                               #   → then spawn the reviewers it names and write review.json
pnpm wp-finish-upsert-pr       # ③ creates/updates the PR
```

Stage ② is where verification happens: it fails on an unresolved merge or a red build BEFORE any
reviewer is spawned, so a broken branch costs no review effort. It records the sha it verified, and
stage ③ skips its own build when HEAD has not moved — three stages, one build.

The full workflow (worktrees, conflicts, the 3-point merge) is documented in
`.webpieces/instruct-ai/webpieces.git-workflow.md`, refreshed on every `wp-*` command.

**The PR description IS the squash-commit body.** Stage ③ renders one compact string — PR link, risk,
non-green flags, a 4-sentence summary, the build-command footer — and uses it as *both* the PR
description and the `--body-file` it merges with. The full dashboard and each reviewer's output go into
the PR's 1st and 2nd comments, so they never reach `git log`.

That makes every landing route agree — the GitHub Merge button, a bare `gh pr merge`, `pnpm wp-land-pr`,
and stage ③'s own auto-merge all write identical bytes. **Nothing here is yours to configure or remember.**
It depends on two GitHub repo settings (`squash_merge_commit_title: PR_TITLE`,
`squash_merge_commit_message: PR_BODY`), and stage ③ verifies and REPAIRS them itself on every run —
see `SquashSettingsEnforcer`. Those live on GitHub's servers, not on disk, so no config key can express
them and no validator can see them; that is exactly why the tooling sets them instead of a doc asking you
to. Without repo-admin rights it prints the one `gh api` command to forward to an owner.

**Prefer `pnpm wp-land-pr` from the CLI** — it also archives the pre-squash tip and reaps the landed
worktree — but the UI button is not wrong, which is the point.

Once the PR merges, clean up. Pick the form for the tree you are in — a linked worktree has no `main` to
check out (`main is already checked out at <primary clone>`), so the two forms are not interchangeable:

- in the primary clone:
  ```bash
  pnpm wp-land-pr && pnpm wp-sync-main
  ```
- in a linked worktree — land, then run the same cleanup **from the primary clone** (`wp-cleanup`
  deliberately spares the worktree you are standing in, so it cannot reap the one you are inside):
  ```bash
  pnpm wp-land-pr
  pnpm wp-sync-main     # from the primary clone
  ```

`wp-sync-main` is one command for one intention: fetch, check out `main`, `pull --ff-only`,
`wp-cleanup`, then sweep the orphan directories an `nx g move` leaves on every clone. Do **not** hand-roll
`git checkout main && git pull origin main && pnpm wp-cleanup` instead — that is the same command minus
the sweep, which is exactly how the sweep never ran for anybody. (The raw pair is still legal git, and it
is deliberately still the L0 version-drift cure, because in an L0 block `node_modules` is the thing in
doubt and no `pnpm` bin can be relied on to load.)

`wp-cleanup` reaps **worktrees first, then branches**, and that order is the whole fix: a worktree HOLDS
its branch, so reaping the tree is what makes the branch reapable, and the branch pass then recomputes
its verdicts against the post-removal truth. Do not hand-run `git worktree prune`/`remove` or
`git branch -D` — the tool does both, in the right order, and archives what it removes.

It removes what it can PROVE is dead — a worktree whose directory is already gone, or whose branch is
dead by a merged PR (its own, or the one it snapshots); a branch that is merged or is a squash-merge
backup of a merged one — **plus every zero-commit husk**: a ref identical to `origin/main`, where the
delete costs a NAME and not a commit. A husk is spared only when somebody is provably HOLDING it: a
worktree with uncommitted or untracked files, one LOCKED by something still there, the tree you are
standing in, a detached HEAD — each reported with that as its reason.

**A claude-agent lock is judged on evidence, never on the pid in it.** The harness writes
`claude agent agent-<id> (pid N …)` on every worktree it opens, and that pid is the SHARED Claude Code
SESSION process — the same number for every subagent, alive for the whole session. So it says nothing,
and wp-cleanup no longer asks the kernel about it. A locked agent worktree is removed only when the
branch evidence already proves it dead (a merged PR, a snapshot of a live ref, a zero-commit husk) AND
the directory is clean AND the harness does not report that agent as mid-tool-call. Harness state can
only ever VETO that removal, never authorise one. Where liveness genuinely cannot be established the
worktree is SPARED and the message says so, instead of claiming somebody is working in it.

Every removal is logged with its pre-delete SHA and a
`recover=` command that brings back both the directory and its branch. Do not stop to ask whether it is
safe to run — it is the sanctioned cleanup command, and asking is what let stale branches and worktrees
pile up in the first place.

Anything carrying UNIQUE COMMITS is never taken by default. It is printed in a numbered, classified
block — identical whether or not there is a terminal — and you act on it with a flag:

```bash
pnpm wp-cleanup --report                 # the whole classified picture, deletes nothing
pnpm wp-cleanup --delete-branches=all    # or =none, or =1,3 by the numbers just printed
pnpm wp-cleanup --delete-worktrees=1,2
pnpm wp-cleanup --interactive            # prompt even with no tty
pnpm wp-cleanup --ignore-stale-locks     # treat a standing claude-agent lock as no evidence
pnpm wp-cleanup --help
```

`--ignore-stale-locks` is the escape hatch for the one thing the command could not previously be told:
that an agent lock is stale. Every locked worktree is then classified on its real branch and commit
state, and the ones that come back dead are unlocked and removed — one flag in place of the
`git worktree unlock` a human otherwise runs per directory. A DIRTY worktree, and one whose agent the
harness still reports as mid-tool-call, are spared under it anyway.

The numbers in a `--delete-*` flag are the numbers printed on the SAME run; a number past the end of the
block stops the run rather than deleting the wrong ref. An explicit flag always beats the terminal sniff
(`isTTY` was only ever a guess about who was standing there).

**The ONLY reasons to stop before posting the PR:**
- The human explicitly said "don't open a PR yet."
- The build or tests are red.

Otherwise, stopping after a green build without posting the PR is a bug — not politeness.
