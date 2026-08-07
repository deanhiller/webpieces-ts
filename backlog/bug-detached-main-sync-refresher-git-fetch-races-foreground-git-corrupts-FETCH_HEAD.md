# BUG: the detached main-sync refresher's `git fetch` races the agent's foreground `git fetch`/`git pull` and corrupts `.git/FETCH_HEAD` — which then breaks the guard's own prescribed cure

**Package:** `@webpieces/ai-hook-rules` / `@webpieces/nx-webpieces-rules`
(`packages/tooling/ai-hook-rules/src/core/main-sync-refresh.ts` → detached `sync-main.ts`)
**Version seen (consuming repo):** installed `@webpieces/nx-webpieces-rules` **`0.4.452`**; guard source
read from `/Users/deanhiller/workspace/personal/webpieces-ts40` @ `main`.
**Reporter context:** hit live **2026-07-29** in `/Users/deanhiller/workspace/acme/consumer-monorepo1`.
On `main`, 18 commits behind origin, every attempt to run the guard's own prescribed cure
`git pull origin main` failed with:

```
From github.com:acme-internal/consumer-monorepo
 * branch            main       -> FETCH_HEAD
fatal: Cannot fast-forward to multiple branches.
```

`.git/FETCH_HEAD` contained the SAME line twice, both marked for-merge:

```
4d9e8bd274a85a3c19d12cc2ff910eaf79bf728c		branch 'main' of github.com:acme-internal/consumer-monorepo
4d9e8bd274a85a3c19d12cc2ff910eaf79bf728c		branch 'main' of github.com:acme-internal/consumer-monorepo
```

`git pull` reads FETCH_HEAD, sees two `for-merge` entries, and refuses — even though both are the
identical SHA. The user reports seeing this "a few times" across sessions.
**Severity:** Medium–High — it wedges `git pull origin main`, which is the exact command
`read-stale-guard` / `redirect-how-to-merge-main` tell the agent to run to get un-stuck. The guard's own
background machinery sabotages the guard's own cure, so the repo stays parked in the stale-`main` state
(see sibling bug `bug-read-stale-guard-has-no-bash-counterpart-...`).

## Root cause

`main-sync-refresh.ts` fires `triggerMainSyncRefresh()` on essentially every guarded tool call (Read
fast-path in hook-core, plus the Bash/Write paths). It `spawn`s a **detached** `sync-main.ts` whose own
docstring (line 21) says it does *"the SLOW work (merged-PR lookup + **git fetch** + merge-base + …)"*.
That `git fetch` is a plain fetch — there is no `--no-write-fetch-head` anywhere in
`packages/tooling/ai-hook-rules/src` — so it **truncates-and-rewrites `.git/FETCH_HEAD`**.

`.git/FETCH_HEAD` is a single file with **no lock in git** protecting it from concurrent fetches. When a
detached refresher's `git fetch` overlaps a foreground `git fetch` / `git pull origin main` (which fetches
internally), the two writes interleave and can leave a **duplicate `main` for-merge line**. `git pull`'s
subsequent merge step then sees "multiple branches" and dies.

The refresher HAS a lock (`.webpieces/main-sync.lock.json`, `inprocess`/`finished` + start epoch,
`sync-main.ts` lines 25-27, 48-49) intended to stop refreshers piling up — but (a) it only serializes
refreshers **against each other**, never against the agent's foreground git, and (b) it is
**check-then-write, not atomic**, so two refreshers can both pass the "is another inprocess?" check before
either writes the lock.

## Evidence (this session's `.webpieces/hooks/guard-async-work.log`)

Every refresh cycle logs the fetcher being launched **twice** — two `SPAWN_ATTEMPT` (same pid, ~20ms
apart) and two `START` children with **different** pids; the loser usually hits `SKIP_INPROGRESS`, proving
two children reached the lock check in the same window:

```
12:24:07.829  SPAWN_ATTEMPT  pid=51631
12:24:07.849  SPAWN_ATTEMPT  pid=51631        ← spawned twice, 20ms apart
12:24:07.888  START          pid=51667
12:24:07.905  START          pid=51669        ← two children running
12:24:07.906  SKIP_INPROGRESS pid=51669  another refresh is in progress
12:24:12.299  FINISH         pid=51667  main  merged=false … ms=4411   ← ~4s of git fetch work
```

That ~4s `git fetch` window recurred at 12:23, 12:24:07, 12:24:42, 12:25:03, 12:25:08 — i.e. a background
`git fetch` was in flight a large fraction of the time, exactly while the agent was running
`git fetch origin main` and `git pull origin main`. Whenever the two overlapped, FETCH_HEAD got the
duplicate line and `git pull` died. It IS this session's guard activity — not a pre-existing repo state.

## Why the duplicate specifically appears (git detail)

A plain `git fetch origin main` writes one `for-merge` line to FETCH_HEAD. Two of them running
concurrently each open FETCH_HEAD for write; depending on interleaving you get the same line twice.
`git pull` treats each `for-merge` line as a branch to merge, so N identical lines read as "N branches"
→ `Cannot fast-forward to multiple branches`, regardless of them being one SHA.

## Suggested fix direction

- **Do not write FETCH_HEAD from the background refresher.** It only needs origin/main's SHA and
  ancestry, so use a form that leaves FETCH_HEAD alone:
  - `git fetch --no-write-fetch-head origin main` (git ≥ 2.29), or
  - `git ls-remote origin refs/heads/main` (no working-git-state mutation at all) for the SHA, or
  - fetch only the remote-tracking ref (`git fetch origin main:refs/remotes/origin/main` semantics) with
    `--no-write-fetch-head`.
  The refresher's consumers (`main-sync-status.json`, merge-base checks) read `origin/main` /
  the cached SHA, not FETCH_HEAD, so nothing downstream needs FETCH_HEAD written.
- **Serialize the refresher against a real lock**, or make the lock acquisition atomic (`O_CREAT|O_EXCL`
  / `mkdir`), so the check-then-write window that lets two children both START is closed. The double
  `SPAWN_ATTEMPT` per cycle should also be investigated — one call is spawning the child twice.
- **Make the cure text robust to it anyway:** have `read-stale-guard` / `redirect-how-to-merge-main`
  suggest `git pull --ff-only origin main` — but note that alone does NOT help here (it hit the same
  `multiple branches` fatal in this session), so the real fix is not corrupting FETCH_HEAD in the first
  place. A documented manual recovery when already wedged: `git fetch --prune origin main` (single
  refspec, rewrites FETCH_HEAD cleanly) then retry, or `git merge --ff-only origin/main`.

## Interaction with the sibling bug

Together the two bugs compound: `read-stale-guard` blocks the Read tool on stale `main` and tells the
agent to `git pull origin main`, its background refresher then corrupts FETCH_HEAD so that pull fatals,
and (per the sibling bug) content-reading **Bash** is NOT blocked — so the path of least resistance for
the agent becomes "keep `cat`/`grep`-ing the stale tree," which is the worst outcome. Fixing this bug
restores the cure; fixing the sibling bug stops the stale reading while the cure is unavailable.
