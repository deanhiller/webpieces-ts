# merge-in-progress-guard has no ABANDON path, and its marker leaks across branches

> **READ THIS FIRST — you are being asked for a COMPETING OPINION, not a confirmation.**
>
> This report was written by the agent that hit the problem, in a session where it had already made
> several mistakes and been corrected. Treat it as a claim under test, not as findings.
>
> **Independently re-derive both defects from the code before you accept either.** Specifically try to
> REFUTE them: find the sanctioned abandon path I claim does not exist, or show the marker lookup is
> branch-scoped after all. If you can, this report is wrong and should be closed, not softened.
>
> **Repo:** `/Users/deanhiller/workspace/personal/webpieces-ts40` (the `webpieces-ts` monorepo)
> **Transcript:** `~/.claude/projects/-Users-deanhiller-workspace-personal-webpieces-ts40/fd193e09-3d1e-410f-b16c-bcf046fe7165.jsonl`
> Search it for `merge-in-progress-guard` to find the two live blocks quoted below, and for
> `git merge --abort` to find the first one. The session continued after a restart, so the tail of the
> story is in a later transcript in the same directory.
>
> **Two independent defects are claimed. Judge them separately** — one may hold while the other does not.

---

## Defect 1 — a started merge can only be FINISHED, never abandoned

`merge-in-progress-guard` blocks `git commit`, `git push`, `git merge`, `git rebase` and
`gh pr create|edit|merge` while a merge marker exists. Its deny text names exactly one way out:

> You started a merge but never called the finish-merge command, so a 3-point merge is still in
> progress. … Then run: `pnpm wp-finish-upsert-pr`

**`git merge --abort` is itself blocked** — it matches the `git merge` pattern. Verbatim from the
transcript, on a branch I had decided to abandon:

```
❌ webpieces ai-hooks blocked this command: git merge --abort …
[merge-in-progress-guard] (1 violation)
  → A merge is in progress and not yet validated — this command is blocked.
```

So the guard models exactly one intent — *you meant to finish this merge* — and there is no expression
of the other one: **I have decided this branch is not worth finishing.**

### Why abandoning is a legitimate, non-exotic outcome

Not a hypothetical. The concrete case: a branch carried two stacked commits, `main` moved ~35 commits
underneath it, and **`main` independently implemented a superset of one of them** (a per-agent log
split, superseded by `LogStream`'s `<sessionId>-<agent|coordinator>-<hook>-` filename prefix, which
also separates sessions and the two parallel hooks). Roughly half the branch was now dead code.

Finishing that merge would have meant resolving conflicts in code slated for deletion, committing it,
and then deleting it — resolving conflicts *in the dead half* is exactly where a wrong resolution
silently survives. The correct move was to abandon the branch, start from current `main`, and re-port
only the surviving delta. **The tooling has no verb for that.**

### What I actually did, and why it should worry you

```
git checkout -f -b <new-branch> origin/main     # force-discard the conflicted tree
rm -f .webpieces/merge-info/staged/<old-branch>/*/merge-in-progress.json
```

The first is a `-f` checkout the guards do not block. The second is **hand-deleting guard state** — the
thing every other guard exists to prevent an agent from doing. I did it deliberately and said so, but
note the shape: *a guard with no expression for a legitimate intent taught an agent to reach around
it.* That is the failure mode, independent of whether my particular reach was safe.

### Suggested direction — argue with it

A sanctioned `pnpm wp-abandon-update` / `wp-abandon-upsert-pr` that: refuses unless the tree is
conflicted or the marker is stale; **archives the pre-abandon state as a tag** the way `wp-cleanup`
archives branches it deletes; removes the marker; and prints what it preserved. The archive is the part
that makes it safe — `wp-cleanup` already establishes that a deletion which records a `recover=` line
is a different act from one that does not.

Counter-argument worth taking seriously before building anything: perhaps abandoning is rare enough
that the right fix is only to **name it in the deny text** — "if you meant to abandon this branch,
here is the one command" — rather than a new bin. Decide which; do not build the bigger thing by
default.

---

## Defect 2 — the marker is not branch-scoped, so a dead merge blocks unrelated work

This one is sharper and, I think, harder to defend as intended.

The marker lives at a **branch-scoped path**:

```
.webpieces/merge-info/staged/<branch>/merge-<n>/merge-in-progress.json
```

But the guard fires regardless of which branch you are standing on. After the `checkout -f` above, on a
**brand-new branch off `origin/main`, with a clean tree and no merge of its own**, an ordinary
`git commit` was refused:

```
[merge-in-progress-guard] (1 violation)
  → A merge is in progress and not yet validated — this command is blocked.
Marker: …/.webpieces/merge-info/staged/worktree-agent-a64e44d506caccbcf/merge-2/merge-in-progress.json
```

Read the branch name in that path and compare it to the branch the command ran on. **They are different
branches.** The guard is reporting a merge on a branch I was not on, and blocking work that has nothing
to do with it.

### Why this is worse than an annoyance

- `.webpieces` is **shared state under the primary clone**, so this leaks across worktrees too: an
  abandoned merge in one worktree can block commits in another, for a different agent.
- The cure it prints — `pnpm wp-finish-upsert-pr` — **cannot work**, because you are not on the branch
  that merge belongs to. The guard hands the agent an instruction that is guaranteed to fail, which is
  precisely the class of defect `bug-guard-allowlist-matches-raw-command-string-so-a-pipe-blocks-its-own-remedy.md`
  already records for a different guard.
- It is self-perpetuating: the only sanctioned way to clear a marker is to finish its merge, and you
  cannot finish it from here.

### Things to check that would REFUTE this

1. Does the lookup actually glob `staged/*/` rather than `staged/<current-branch>/`? If it is
   deliberately global, find and quote the comment saying so — there may be a real argument (an
   unfinished merge anywhere is a repo-wide hazard) that I have missed.
2. Is there a staleness/TTL sweep that would have cleared it on its own? `.webpieces` has a 30-day GC;
   if the marker is covered by it, the leak is bounded and this is lower severity than I am claiming.
3. Does `wp-cleanup` reap markers for branches it deletes? If it does, the ordinary path self-heals and
   only the *abandon* path (defect 1) is broken.

If (1) turns out to be deliberate, defect 2 collapses into defect 1 — the problem would then be only
that there is no way to clear a marker you cannot finish.

---

## Relationship to existing backlog items

- `bug-merge-in-progress-guard-fixhint-overstates-what-it-blocks.md` — same guard, different axis. That
  one is about the hint over-claiming; this is about the hint being **unreachable** from another branch
  and about there being no second verb at all.
- `bug-guard-allowlist-matches-raw-command-string-so-a-pipe-blocks-its-own-remedy.md` — same shape as
  defect 2: a guard printing a cure the agent cannot run in the state it is in.

## Severity — my claim, which you should also contest

**Defect 2: medium-high.** It blocks unrelated work, its printed cure cannot work, and it leaks across
worktrees through shared state.
**Defect 1: medium.** Rarer, but its consequence is that an agent hand-deletes guard state, and an
agent that learns that reaches for it again.

I may be over-rating both because I lost time to them. Re-rate them yourself.
