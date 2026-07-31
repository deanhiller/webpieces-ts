# FEATURE: give every worktree its own `.webpieces/` state under the primary clone, via a scoped resolver

**Package:** `@webpieces/rules-config`, `@webpieces/ai-hook-rules`, `@webpieces/pr-gate`
**Version seen:** `0.4.509`
**Severity:** High — one confirmed wrong-results bug (`branch-creation-guard` blocking on a phantom
count), one filed corruption bug (concurrent `git fetch` on a shared `.git`), and state that is
destroyed when a worktree is removed.

**Source:**
- `packages/tooling/rules-config/src/repo-root.ts` (`RepoRootFinder.resolveRepoRoot`)
- every writer/reader of `.webpieces/...` across the three packages
- `.gitignore:102` — `.webpieces/` is ignored; **zero tracked files** (verified)

Related: [`bug-branch-creation-guard-calls-live-worktrees-dead-and-miscounts-parked-branches`](./bug-branch-creation-guard-calls-live-worktrees-dead-and-miscounts-parked-branches.md),
[`bug-detached-main-sync-refresher-git-fetch-races-foreground-git-corrupts-FETCH_HEAD`](./bug-detached-main-sync-refresher-git-fetch-races-foreground-git-corrupts-FETCH_HEAD.md),
[`bug-bash-guards-judge-the-shell-cwd-not-the-paths-the-command-touches`](./bug-bash-guards-judge-the-shell-cwd-not-the-paths-the-command-touches.md).

## The problem

`RepoRootFinder` resolves the root by walking up to the directory holding `webpieces.config.json`.
In a linked worktree that is the **worktree itself**, so every worktree grows its own `.webpieces/`.
A repo with seven worktrees has seven copies of `merged-branches.json`, `branch-mutations.log`,
`main-sync-status.json`, `merge-info/`, `pr-review/` and `instruct-ai/`.

Three consequences, all observed:

1. **Repo-wide facts stored per-worktree are simply wrong.** `merged-branches.json` describes every
   branch and worktree in the repo. `branch-creation-guard` reported *"8 parked local branches"* while
   `git branch --list` showed **1**, then blocked a legitimate `git worktree add` on that figure — it
   was reading a copy that predated deletions made from another worktree.
2. **N refreshers race on one `.git`.** Each worktree spawns its own detached main-sync refresher, and
   concurrent `git fetch` against a shared `.git` corrupts `FETCH_HEAD` (already filed).
3. **State dies with the worktree.** `git worktree remove` takes `merge-info/` and the recovery log
   with it — and recovery is the whole justification for letting the tooling delete branches unattended.

## The design

```
{primary-clone}/.webpieces/
    merged-branches.json          ← SHARED
    main-sync-status.json         ← SHARED
    main-sync.lock                ← SHARED
    worktrees/{worktreename}/     ← PER-WORKTREE, isolated, survives worktree removal
        hooks/branch-mutations.log
        merge-info/staged|merged/{branch}/  (+ index.json)
        pr-review/{branch}/
        instruct-ai/*.md
```

The primary clone keeps using `{primary}/.webpieces/` directly for its own local state; only **linked**
worktrees get a `worktrees/{name}/` namespace.

### A resolver, NOT a symlink

Symlinking `<worktree>/.webpieces` → the namespace was considered and **rejected**: nothing hooks
`git worktree add`, so it needs lazy creation that also handles "link exists", "link points elsewhere"
and "a real directory is already there" — invisible filesystem magic with a Windows failure mode.
Worse, the safe way to write a shared file is temp + `rename()`, and **`rename()` replaces the symlink
with a real file**, silently un-sharing it for every other worktree.

Instead, two **named** methods — not a boolean flag, since `resolve(true)` at a call site says nothing:

```ts
dotWebpieces.shared(startDir)   // {primary}/.webpieces
dotWebpieces.local(startDir)    // {primary}/.webpieces/worktrees/{name}  (linked worktree)
                                // {primary}/.webpieces                   (primary clone)
```

Every `.webpieces/...` call site must be updated to call one of them. That is the point: each site
**declares its scope**, which is the distinction that keeps going silently wrong.

### Scope assignment

| Path | Scope | Why |
|---|---|---|
| `merged-branches.json` | `shared()` | repo-wide verdicts; per-worktree copies caused the phantom count |
| `main-sync-status.json` + lock | `shared()` | single-flight needs a shared lock — a per-worktree lock locks nothing |
| `hooks/branch-mutations.log` | `local()` | one writer, cannot tear; survives removal; findable by glob |
| `merge-info/`, `pr-review/` | `local()` | branch-keyed; git guarantees one branch ⇒ one worktree |
| `instruct-ai/*.md` | `local()` | regenerated every `wp-*` run; identical everywhere |

**`branch-mutations.log` is deliberately NOT shared.** `O_APPEND` writes are atomic only under
`PIPE_BUF` — **512 bytes on macOS** — and a `recover=git worktree add -b <branch> <abs-path> <tag>` line
with full paths exceeds that, so concurrent appends would interleave into unrecoverable garbage. Under
this layout a per-worktree log survives removal anyway, and recovery is one glob:
`{primary}/.webpieces/worktrees/*/hooks/branch-mutations.log`.

### Concurrency

- **`merged-branches.json`** — write to a temp file in the same directory, then `rename()`. Atomic on
  POSIX, so a reader sees old or new, never torn. Note this gives **no lost-update protection**: two
  read-modify-write cycles end with last-writer-wins. Acceptable — it is a derived cache, and
  `wp-cleanup` already recomputes rather than trusting it for deletions. Do not let a later caller
  assume it is transactional.
- **main-sync single-flight** — `O_EXCL` create on `{primary}/.webpieces/main-sync.lock`
  (`fs.openSync(path, 'wx')`). POSIX guarantees exactly one winner; everyone else gets `EEXIST`, reads
  `main-sync-status.json`, and skips. The holder fetches, writes status, releases.
  **Handle a stale lock**: write PID + timestamp, and take over when the PID is dead or the age passes a
  bound. Breaking is itself racy, but the worst case is two fetches rather than corruption — whereas a
  lock nobody can clear is worse than the race it prevents.
- **Per-branch dirs** need no locking (disjoint paths), but `merge-info/index.json` is shared within a
  worktree — treat it like `merged-branches.json`.

### What does NOT move

**`webpieces.config.json` stays per-worktree.** It is **tracked in git** and part of the branch — a
branch may legitimately change its own rules, and that must keep working. Only the gitignored
`.webpieces/` state relocates. Conflating the two would be a serious regression.

### Detecting a worktree — canonically

```
git rev-parse --git-dir          # <primary>/.git/worktrees/<name>  (linked)  |  <primary>/.git  (primary)
git rev-parse --git-common-dir   # <primary>/.git                    (always)
```

Differ ⇒ linked worktree. Name = `basename` of `--git-dir`; primary clone = `dirname` of
`--git-common-dir`. Works from any subdirectory; never parse the `.git` file's `gitdir:` line by hand.
`WorktreeService` and `EffectiveTreeResolver` (`ai-hook-rules/src/core/effective-tree.ts`, from #524)
already distinguish primary from linked — reuse one rather than adding a third mechanism.

### Migration and transition

- A legacy `<worktree>/.webpieces/` real directory holding an **in-flight** `merge-info/` must move into
  `worktrees/{name}/` — never orphaned, never destroyed.
- The `wp-*` bins and hooks run the **PUBLISHED** package, so old (per-worktree) and new (resolved)
  invocations will coexist for one release. Reads should find state in either location; nothing may be
  lost.

## Worth knowing

Claude Code loads hooks from the **session's project directory** — the primary clone — so a subagent
working in a linked worktree still fires the **primary clone's** hook binary and `node_modules`. The
enforcer is singular even when the trees are not, which is an additional argument for the shared facts
living with the primary clone.

## Tests

Over **real git repos with real linked worktrees** (`worktree-reaper.spec.ts` and
`branch-creation-guard.e2e.spec.ts` show the pattern):

- `local()` from a linked worktree resolves under `worktrees/{name}/`; from the primary clone resolves to
  `{primary}/.webpieces`
- `shared()` resolves to `{primary}/.webpieces` from both
- `webpieces.config.json` still resolves **per-worktree**
- two concurrent writers of `merged-branches.json` never produce a torn read
- only ONE refresher runs when several worktrees start at once, and a stale lock is recoverable
- a legacy per-worktree `.webpieces/` migrates without losing an in-flight `merge-info/`

Run `pnpm run build-all` with **`NX_PARALLEL=1`** — under parallel agent load vitest's reporter RPC
starves and yields `Timeout calling "onTaskUpdate"` on runs where every test passed.
