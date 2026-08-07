# BUG / RFC: `~/.webpieces` and repo `.webpieces` layout is inconsistent and scattered — reorganize logs, audit, pr-info, and review data

**Reported:** 2026-08-07 · **Reporter:** Dean (via Claude Code, session `8ae9e533-…`)
**Severity:** Medium — not a correctness break, but the on-disk layout is incoherent across the home dir and the repo dir, making logs/audit/review data hard to find and reason about. Dean's words: *"this whole layout is fucked… we need logs and auditing and pr-info and review data, ALL OF IT"* fixed.
**Component:** webpieces AI-hooks / wp-* tooling file layout (home `~/.webpieces/` + repo `<repo>/.webpieces/` + `<repo>/.claude/webpieces/`).

---

## ⚠️ FOR THE WEBPIECES AI / MAINTAINER — please VET & propose the target layout

This is a design/organization report, not a proven defect. Dean wants you to **decide the correct consolidated layout and push back** where my read of "what's wrong" is off. Two things are asserted as intended-but-not-happening (confirm/refute):

1. **Logs are supposed to live at `~/.webpieces/logs`** (per Dean), but that dir does not exist — logs are actually written into the **repo** at `<repo>/.webpieces/logs`.
2. **`~/.webpieces/prs/` should be keyed `{token}/{repo}`**, but it currently has an extra **host** segment `{host}/{owner}/{repo}` (`github.com/…` and `personal/…`). *"We only work with GitHub right now"* — the `github.com` level is unnecessary nesting.

## Current state (observed 2026-08-07)

**Home `~/.webpieces/`:**
```
~/.webpieces/
  ai-hooks/
  local-modules/
  prs/                      # per-PR body reporting for wp-land-pr
    github.com/acme-internal/consumer-monorepo      # <- unwanted host segment
    personal/acme-edu/consumer-repo
    personal/deanhiller/webpieces-ts
  # NO logs/ here  <-- Dean expects ~/.webpieces/logs
```

**Repo `<repo>/.webpieces/`** (this repo-local layout *worked well* — the migration to `~/.webpieces` is what raised the keying question):
```
<repo>/.webpieces/
  hooks/
  instruct-ai/
  logs/                     # <- logs actually here (Dean expects ~/.webpieces/logs)
  main-sync-status.json
  main-sync.lock.json
  merge-info/
  merged-branches.json
  pr-info/                  # PR body/info (note: home dir ALSO has ~/.webpieces/prs — split/confusing)
  pr-review/                # review data
  worktrees/<agent-id>/pr-review/<branch>/       # <- AUDIT + REVIEW data ALSO here, per-worktree:
      provenance.json                            #    audit record (reviewer credit)
      diff/                                       #    materialized diff offered to reviewers
      instructions/                              #    per-checklist instructions
      review-<id>.json                           #    reviewer verdicts
```

**Repo `<repo>/.claude/webpieces/`:** `ai-hook.sh`, `guarantee-root.sh`

**Provenance SOURCE data (Claude Code territory, read by webpieces):**
`~/.claude/projects/<cwd-slug>/<sessionId>/subagents/agent-<id>.{jsonl,meta.json}`

## The problem

There is **no coherent home** for the four things Dean named — **logs, auditing, pr-info, review data** — they are split awkwardly across three roots:

- **logs** → repo `.webpieces/logs` (Dean expected `~/.webpieces/logs`)
- **pr-info (bodies)** → home `~/.webpieces/prs/{host}/{owner}/{repo}` (unwanted `{host}` level)
- **audit + review data (provenance, diffs, verdicts)** → repo `.webpieces/worktrees/<agent>/pr-review/<branch>/`
- **provenance source (subagent transcripts)** → `~/.claude/projects/.../subagents/`
- **merge/sync bookkeeping** → repo `.webpieces/{merge-info,merged-branches.json,main-sync-*}`

Home-vs-repo placement looks accidental rather than principled: some machine-global state is in the repo (`logs`, `merged-branches.json`, provenance audit), some per-repo state is in the home dir (`prs`). A reader can't predict where a given artifact is.

## Design discussion — consolidating to `~/.webpieces`: WHAT DIMENSIONS? (this is the RFC part — DISCUSS, don't just pick)

The migration goal is to move everything under `~/.webpieces/` (so it survives repo/worktree wipes and lives in one place). The hard part is the **keying dimensions**, and the key realization is that **different artifacts have different NATURAL keys** — so `~/.webpieces/prs/{token}/{repo}` alone does **not** work.

**Dimensions in play:**
- **`{token}/{repo}`** — the GitHub repo (owner/repo). Drop `{host}` while GitHub-only; re-introduce only if a second host ever appears.
- **`{clone}`** — the working directory: the primary checkout, each git worktree (`agent-<id>`), and any fresh clone an agent makes. **Multiple clones of the same repo coexist on one machine** — this is the dimension `{token}/{repo}` misses.
- **`{sessionId}`** — a Claude Code session (main loop).
- **`{agentId}`** — a subagent within a session. Unique per spawn; a worktree-isolated agent maps 1:1 to a clone, a non-isolated reviewer shares its parent's clone.

**Confirmed:** `{sessionId}-{agentId}` IS globally unique across all clones (agentId is a unique per-spawn id, sessionId unique per session) — so it never collides. The problem with it is *navigability*, not uniqueness.

**Core observation — artifacts split into two key-families:**
- **PR bodies (`prs`/`pr-info`) + audit/review (`pr-review`, `provenance.json`, verdicts)** are **repo+branch/PR-scoped**, NOT clone-scoped: the same PR reviewed from any clone is one PR. Natural key: `{token}/{repo}/{branch|pr}/…`.
- **hook logs** are **execution-scoped**: they run in a specific clone under a specific session/agent. Natural key: `{token}/{repo}/{clone}/…`.

Forcing one uniform key onto both is what makes every option feel wrong.

### Options (Dean's, for you to evaluate & push back on)

**Option A — flat session-agent under repo:**
```
~/.webpieces/{token}/{repo}/prs/…
~/.webpieces/{token}/{repo}/logs/{sessionId}-{agentId}-hook.log
```
- ✅ globally unique filenames, no collisions.
- ❌ a flat pile of `{sessionId}-{agentId}` files is **hard to browse and evaluate** — you can't tell at a glance which clone/branch a log came from. Dean: *"gets fucking confusing… I don't like it."*

**Option B — key logs by clone dir (Dean's current lean):**
```
~/.webpieces/{token}/{repo}/{clonedDirName}/logs/****
```
- `{clonedDirName}` = basename of the working dir (`consumer-monorepo3` for the primary tree, `agent-<id>` for a worktree, the clone's dir name for a fresh clone) — **human-recognizable, matches `git worktree list`**, so logs are easy to locate and evaluate.
- Open questions for the webpieces AI:
  1. Is `{clonedDirName}` **stable & unique enough** within a `{token}/{repo}`? (worktree ids + the primary dir are unique; two *fresh clones* could in principle pick the same dir name — need a disambiguation rule, e.g. suffix, or fall back to `{sessionId}-{agentId}` in the filename.)
  2. Under a clone, do individual runs get `logs/{sessionId}-{agentId}-hook.log` filenames so multiple agents sharing a clone stay distinct?
  3. **Hybrid?** Keep logs clone-keyed but keep PRs/audit/review **repo+branch-keyed** (NOT under `{clonedDirName}`), since they're not clone-scoped:
     ```
     ~/.webpieces/{token}/{repo}/{clonedDirName}/logs/{sessionId}-{agentId}-hook.log   # execution-scoped
     ~/.webpieces/{token}/{repo}/pr/{branch}/{prs,pr-review,provenance.json,verdicts}   # repo+branch-scoped
     ```
     This is Dean's lean + the two-key-family split. **Evaluate whether `{clonedDirName}` is the right log dimension, and whether this hybrid is the clean answer — report options back for discussion.**

Two fixes fall out regardless of the final shape:
1. **Logs must land in `~/.webpieces` (not repo `.webpieces/logs`)** — or explicitly decide repo-local is correct and update the intent; pick one.
2. **Drop the `github.com` host segment** → key by `{token}/{repo}`.

## Paths for your investigation

- Home root: `/Users/deanhiller/.webpieces/` (`ai-hooks/`, `local-modules/`, `prs/`)
- Repo root: `/Users/deanhiller/workspace/acme/consumer-monorepo3/.webpieces/` and `.../.claude/webpieces/`
- Provenance source: `~/.claude/projects/-Users-deanhiller-workspace-acme-consumer-monorepo3/<sessionId>/subagents/`
- Related report in this dir: `BUG-subagent-provenance-gitbranch-mismatch.md` (the provenance audit data is one of the "review data" artifacts this reorg should give a stable home).

---

## Resolution

**Decided 2026-08-07 by Dean. State STAYS in `{repo}/.webpieces/`. The move to `~/.webpieces` was
considered and REJECTED.** This report's central premise — that logs were *meant* to live at
`~/.webpieces/logs` and are in the wrong place — is refuted. They are where they belong.

The machine-global tier is not merely unused, it is being **deleted**: `MachineStateHome`,
`PrBodyStore` and the `~/.webpieces/prs/` layout go away in a sibling PR, which also supersedes
[`decisions/0004`](../decisions/0004-pr-artifacts-are-machine-global.md) and removes
`decisions/0001 § D3`'s `WEBPIECES_STATE_HOME` override.
[`decisions/0001 § D1`](../decisions/0001-tree-identity-and-governance.md) — "State moves out of the
repo" — is amended in place and marked REVERSED, with the argument recorded there rather than here.

### Premises this report asserted, and what was actually true

| the report said | verdict |
|---|---|
| "Logs are supposed to live at `~/.webpieces/logs`, but that dir does not exist" | **REFUTED.** In-repo is the intended and now-confirmed home. `find ~/.webpieces -name '*.log'` returns zero, and it should. |
| "`~/.webpieces/prs/` has an unwanted `{host}` segment" | **REFUTED as stated.** The first segment is not consistently a hostname — the observed values were `github.com`, `personal` and `acme-internal`, i.e. a mix of host and org. So the fix is not "drop the host level"; the whole store is being removed, which makes the keying question moot. |
| "`pr-info/` and `~/.webpieces/prs` are a confusing split" | **STALE.** `pr-info/` was renamed to `pr-review` (`rules-config/src/constants.ts`); no writer for `pr-info/` exists in source. The directories still on disk in several repos are residue. |
| "Home-vs-repo placement looks accidental" | **PARTLY FAIR, and now moot.** There is exactly one tier: `{repo}/.webpieces/`, split by `DotWebpieces.shared()` (repo-wide facts) vs `.local()` (one tree). Nothing is in `$HOME`. |
| "no coherent home for logs / auditing / pr-info / review data" | **ADDRESSED**, in place rather than by relocation — see below. |

### What was actually fixed (this PR)

1. **Rejection DETAIL files no longer collide between agents.** They were
   `hooks/<YYYY-MM-DD>/writeInfo-<epochMs>.md` — a directory keyed only by the date and shared by every
   writer in the tree — so two agents blocked in the same millisecond wrote the same path and one
   silently overwrote the other. They now live in `logs/<sid>-<agent>-<hook>-hook-rejection/`, a
   directory named exactly like the log that indexes them, so ownership is unique by construction. The
   file's own comment claiming "a per-worktree log has exactly one writer" was a load-bearing false
   statement and is deleted.
2. **Retention is filename-based.** There is no date level left, so a `writeInfo-*.md` is expired by
   the `<epochMs>` in its NAME (no `stat`), and a stream directory emptied by the sweep is removed.
   Idempotent and race-tolerant — concurrent agents deleting the same week-old file is normal.
3. **The `hooks/` state directory is gone entirely**, along with the lazy once-per-process
   `hooks/*.log → logs/` migrator. That migrator was itself the defect it claimed to cure: it fires
   only in trees a process happens to re-enter, so it guarantees two answers to "where are the logs"
   forever. Per CLAUDE.md, deleted rather than deprecated. Old files on disk are inert.
4. **The detached main-sync refresher no longer writes to a shared stream.** It is a separate node
   process whose `LogStream` was never identified, so it wrote every `START`/`FINISH`/`ERROR` to one
   `unknown-coordinator-hook-guard-async-work.log` shared by every agent — the exact multi-writer
   tearing `LogStream` exists to remove, and it split one refresh cycle across two files, which made
   the documented "SPAWN_ATTEMPT with no START means the child died" check read as a false failure on
   every cycle. The spawner's identity now travels on the child's argv.
5. **Documentation.** `ai.logging.md` was six lines about APPLICATION logging with nothing saying so;
   it now says so, and the TOOLING layout has a real home at
   [`docs/tooling-logs.md`](../docs/tooling-logs.md), linked from `GUARD_MATRIX.md`.

### Not done, deliberately

- `branch-mutations.log` keeps a **bare** name. `LogStream` lives in `ai-hook-rules`, which depends on
  `rules-config`, so the import direction forbids reusing it there; and the `wp-*` bins that write it
  have no session/agent identity to prefix with, so routing it through `LogStream` today would produce
  `unknown-coordinator-hook-branch-mutations.log` — the same single shared file under a longer name.
  Rationale is recorded on `BranchMutationLog.branchMutationLogPath`.
- The subagent-provenance question raised at the end of this report is its own file:
  `BUG-subagent-provenance-gitbranch-mismatch.md`.
