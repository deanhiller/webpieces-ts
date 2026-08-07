# BUG: merged-branch guard does not gate the Bash tool — a full assistant session ran on an already-merged branch

**Package:** `@webpieces/ai-hook-rules` / `@webpieces/nx-webpieces-rules` (the PreToolUse guard chain that
writes `.webpieces/hooks/guard-*.log` + `.webpieces/main-sync-status.json`)
**Version seen (consuming repo):** installed `@webpieces/*` **`0.4.443`** (catalog `&wp 0.4.443`)
**Reporter context:** hit live on **2026-07-25** in a consuming monorepo. An assistant (Claude Code,
Opus 4.8) was asked an unrelated question ("where are we on the lang MCP server, boot the stack") while
the checked-out branch had **already been squash-merged as PR #194**. The assistant ran ~13 Bash
commands — `git`, `curl`, `cat`, and notably `scripts/local.sh start lang` (which boots servers) — and
**every single one was allowed**, with no redirect to cut a fresh branch off main.
**Severity:** Medium–High — the guard's whole purpose is to stop work on a stale/merged branch and
redirect to `git checkout -b <new> origin/main`. Here it detected the merged state correctly and then
**failed open on Bash**, so the protection silently did nothing for an entire session.

## Where reproduced (consuming monorepo)

Full path: **`/Users/deanhiller/workspace/acme-edu/consumer-repo1`** (an AI can read it directly).
Relevant artifacts there (all under `.webpieces/`):
- `main-sync-status.json` → `{"branch":"deanhiller/contextkey-typed","branchAlreadyMerged":true,"mergedPr":"194","conflict":true,"forkPoint":"01e2e4f…","localMain":"01e2e4f…","originMain":"cae0343…"}`
- `merged-branches.json` → lists `deanhiller/contextkey-typed` in `keep` with `"pr": 194`, reason "checked out in worktree … remove that worktree before deleting the branch".
- `hooks/guard-invocations.log` — proves the Bash guard **computed and knew** the merged status.
- `hooks/guard-sync-decisions.log` — proves it **allowed anyway**.
- `webpieces.config.json` → `hookGuards` has all of `feature-branch-guard`, `main-stale-guard`,
  `redirect-how-to-merge-main`, `branch-creation-guard` (`autoReapMergedBranches: true`), `pr-merge-cleanup`,
  `merge-in-progress-guard` set to `"mode": "ON"`.

## The corrupt state the guard was supposed to catch

After PR #194 squash-merged, the local repo is in the classic post-merge foot-gun state:
- The **feature branch pointer** `deanhiller/contextkey-typed` sits **on the squash-merge commit itself**
  (`627f2d6 "Squash merge of deanhiller/contextkey-typed"`), i.e. one commit *ahead* of local `main`.
- Local `main` is **stale** (`localMain=01e2e4f`) while `originMain=cae0343` — so `git branch --merged main`
  reports the branch as NOT merged (from stale main's view the squash commit is a descendant), even though
  `branchAlreadyMerged:true` / `mergedPr:194` is correct.
- `conflict: true` on 3 files (`auth-client-config.ts`, `CompanyHeaders.ts`, `serverClient.ts`), so the
  "sync main into the branch" recovery path is itself blocked.

This is exactly the state the guard chain exists to detect and redirect away from. It detected it and
did not redirect.

## Evidence: the guard KNEW, and allowed anyway

`hooks/guard-invocations.log` — the Bash PreToolUse hook logs the sync status it computed on each call.
The merged status flips to `PR#194` at 05:35:35 and stays there for the rest of the session:

```
05:35:31  Bash  git log … show-current           merged=no       ts=05:29:01   (stale cache from branch-creation)
05:35:40  Bash  ls services/…/mcp …              merged=PR#194   ts=05:35:35   ← detected
05:35:49  Bash  gcloud secrets versions access…  merged=PR#194   ts=05:35:44
05:36:38  Bash  scripts/local.sh start lang       merged=PR#194   ts=05:36:11   ← BOOTS SERVERS, allowed
05:36:47  Bash  curl …/health …/mcp …            merged=PR#194   ts=05:36:42
05:38:35  Bash  git branch --show-current …      merged=PR#194   ts=05:36:51
…all subsequent Bash: merged=PR#194 fork=true conflict=true…
```

`hooks/guard-sync-decisions.log` — the decision recorded for **every** one of those Bash calls:

```
05:35:40  ALLOW  Bash  …  deanhiller/contextkey-typed  -  no bash-guard block  -
05:36:38  ALLOW  Bash  scripts/local.sh start lang     deanhiller/contextkey-typed  -  no bash-guard block  -
05:36:47  ALLOW  Bash  curl …                          deanhiller/contextkey-typed  -  no bash-guard block  -
```

So the merged status (`merged=PR#194`) is computed and logged by the Bash hook, but the **decision
function ignores it for the Bash tool** — the reason column is always the constant `no bash-guard block`.
Contrast the Write/Edit path in the same file, which *does* consult it (`feature-branch-guard` /
`read-stale-guard`, reasons like `clean-feature-branch` / `stale-cross-branch-cache (fail-open)`).

## Root cause (hypothesis for the maintainer)

Two distinct gaps, the first is the real bug:

1. **The Bash tool has no merged-branch gate.** `feature-branch-guard` / `read-stale-guard` /
   `main-stale-guard` gate **Write/Edit/Read** (and `redirect-how-to-merge-main` gates git-mutation Bash
   like merge/rebase), but there is **no guard that blocks ordinary Bash when `branchAlreadyMerged` is
   true**. The status is even fetched and logged on the Bash path (`guard-invocations.log`), so the data
   is right there — it is simply not fed into a block decision. Expected: once the current branch is
   detected merged (and especially with `conflict:true` / stale local main), Bash should be denied with
   the standard "this branch is merged — cut a fresh one off main" redirect (the
   `branch-fresh-off-main-after-merge` guidance), the same way Write/Edit would be.

2. **Stale per-branch decision cache on the guarded (Write/Edit) path.** The last Write decision in this
   session (05:28:56, `review.json`) was cached as `merged=no ts=05:28:49` — computed while the branch was
   genuinely fresh, seconds before PR #194 merged. The async recompute later flipped it to `PR#194`, but
   the sync decision path trusts the cached snapshot keyed by branch and there is a documented
   `stale-cross-branch-cache (fail-open)` branch in `guard-sync-decisions.log`. No Write/Edit happened
   after the flip *in this session*, so this one is a latent risk rather than a proven miss here — but it
   means even the guarded tools can fail-open for a window after a merge lands mid-session.

## Repro (deterministic)

```
git checkout -b feat/x origin/main         # fresh branch
# … make a commit, open + squash-merge its PR (via wp-start/finish-upsert-pr) …
# do NOT switch branches; leave feat/x checked out (now == the squash-merge commit)
git status                                  # ← allowed
scripts/local.sh start lang                 # ← allowed — a whole session proceeds on a merged branch
# .webpieces/main-sync-status.json shows branchAlreadyMerged:true, mergedPr set
# .webpieces/hooks/guard-sync-decisions.log shows every Bash: "no bash-guard block"
```

## Suggested fix direction

- Add a merged-branch check to the **Bash** decision path (it already has the status in hand): when
  `branchAlreadyMerged === true` for the current branch, DENY non-recovery Bash with the redirect to
  `git checkout -b <new> origin/main`, allowlisting only the recovery/cleanup commands (branch switch,
  worktree removal, `git checkout main && git pull`, the `wp-*` cleanup bins).
- Have the guarded-tool path **re-read `main-sync-status.json` freshness** (or invalidate the per-branch
  cache) when the async recompute has written a newer `timestamp`/`branchAlreadyMerged` than the cached
  snapshot, instead of fail-open on a stale-but-same-branch cache.
- Consider treating `conflict:true` + stale `localMain` (branch pointer ahead of local main) as an
  independent "branch is in a post-merge dirty state" signal that also triggers the redirect, since
  `git branch --merged main` will (correctly) report "not merged" in that state and cannot be relied on.

## Impact if unfixed

An assistant handed an unrelated task will happily run a full session — including booting local
servers and git operations — on a branch that is already merged and conflicts with main, exactly the
scenario every `hookGuards.*` in the config is turned ON to prevent. The guard reports the state in its
logs while allowing the work, which is worse than a missing guard because the logs read as "handled".
