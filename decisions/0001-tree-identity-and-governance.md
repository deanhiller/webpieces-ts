# 0001 — Tree identity and governance

**Status:** open — measurements settled, decisions partly taken
**Measured:** 2026-08-06, macOS (darwin 25.3.0), git 2.x, this repo at `156b23b`
**Owns the axis behind:** `backlog/bug-feature-branch-guard-judges-a-subagent-verdict-write-against-the-primary-clones-live-branch.md`,
`backlog/bug-bash-guards-judge-the-shell-cwd-not-the-paths-the-command-touches.md`,
`backlog/bug-outside-tree-kind-is-never-consumed-so-a-non-git-dir-is-judged-against-the-governed-repo.md`,
`guards/L1-location.md` § "Not done"

---

## 1. The problem in one sentence

A single tool call has **four independent "where am I" answers**, the tooling conflates them, and
every conflation has produced a live incident.

| # | identity | answers | resolved by | anchored at |
|---|---|---|---|---|
| 1 | **which tree the work touches** | primary / linked worktree / foreign / outside | `EffectiveTreeResolver` (`effective-tree.ts`) | the payload's `cwd` + a leading literal `cd` |
| 2 | **which release governs it** | a `@webpieces/*` version | the L0 sh shim | `$ROOT` = `$CLAUDE_PROJECT_DIR`, fixed at session start |
| 3 | **which state dir it reads/writes** | `<primary>/.webpieces[/worktrees/<name>]` | `DotWebpieces` (`state-dir.ts`) | git's `--git-dir` / `--git-common-dir` |
| 4 | **who is calling** | coordinator / subagent `<agentId>` | `AgentIdentity` (`coordinator-worktree.ts`) | the PreToolUse payload's `agent_id` |

They are genuinely different questions. #1 and #4 are orthogonal (a subagent may work in the primary;
the coordinator may work in a worktree). #2 currently ignores #1 entirely. #3 ignores #4 entirely
(PR #579 fixes that half).

---

## 2. Measured facts

Everything below was run, not reasoned. Re-run before trusting it.

### 2.1 `git rev-parse --git-dir` and `--git-common-dir` disagree in FORM, not just value

```bash
git -C <dir> rev-parse --git-dir --git-common-dir
```

| asked from | `--git-dir` | `--git-common-dir` | equal as strings? |
|---|---|---|---|
| primary toplevel | `.git` | `.git` | yes ✅ |
| **primary subdirectory** | `/…/primary/.git` (abs) | `../../.git` (rel) | **no ❌ — same dir, different string** |
| linked worktree toplevel | `/…/primary/.git/worktrees/wt-a` | `/…/primary/.git` | no ✅ |
| linked worktree subdirectory | `/…/primary/.git/worktrees/wt-a` | `/…/primary/.git` | no ✅ |

Row 2 is the trap. It is the ONLY row where equality-as-strings gives the wrong answer, and it is
reachable from any hook that fires with `cwd` inside a subdirectory of the primary clone.

**Who gets it right and who does not:**

- `DotWebpieces.gitDirs()` (`state-dir.ts:247-256`) is **correct** — `revParse()` ends with
  `path.resolve(cwd, printed)`, which normalises the `..` segments away.
- `wp_resolve_log_dir()` in `templates/ai-hook.sh:109-135` is **wrong** — it only prefixes a relative
  path with `$WP_CWD/` and never normalises, so row 2 falls into the linked-worktree branch and
  `WP_TREE="${_wp_gd##*/}"` evaluates to the basename of `/…/.git`, i.e. the literal string **`.git`**.

That is the origin of the mystery directory `.webpieces/worktrees/.git/logs/ai-hook-shim.log` reported
in §7 of the feature-branch-guard backlog bug. It is shim-only, which is why nothing else looked wrong.

**Fix shape (verified against all four rows):** resolve to the worktree toplevel first, then ask git
the pair from there — row 2 becomes `.git`/`.git`, rows 3 and 4 are untouched because both values are
already absolute there.

```sh
_wp_tl="$(git -C "$WP_CWD" rev-parse --show-toplevel 2>/dev/null)"
_wp_rp="$(git -C "${_wp_tl:-$WP_CWD}" rev-parse --git-dir --git-common-dir 2>/dev/null)"
```

Deliberately NOT `cd … && pwd -P`: that resolves symlinks, which `path.resolve()` does not, so the sh
side would re-diverge from its TS twin on any symlinked repo path.

### 2.2 Two kinds of linked worktree behave OPPOSITELY for `node_modules`

This is the single most consequential finding here, and it contradicts the model the tooling encodes.

| worktree layout | who creates it | own `node_modules`? | Node walk-up reaches the primary's? |
|---|---|---|---|
| `<primary>/.claude/worktrees/agent-<id>` — **nested** | the Agent tool's `isolation: "worktree"` | no | **YES** |
| `../<feature-dir>` — **sibling** | the `wp-*` / CLAUDE.md convention | no | no |

Measured by walking Node's module-resolution ancestor chain from each path. The nested case reaches
`<primary>/node_modules` because Node walks *filesystem ancestors* and `.claude/worktrees/agent-X` is
literally inside the primary clone.

**Consequences, and they are opposite:**

- **Nested (every subagent):** the worktree silently resolves the **primary's** `@webpieces` release,
  no matter what its own branch pins. No fault fires. Two trees on two releases is indistinguishable
  from two trees on one — the drift is invisible rather than blocked.
- **Sibling:** nothing resolves at all, so the very first tool call is fault **X** (bin missing), cured
  by `cd <worktree> && pnpm install`. This is the case `templates/ai-hook.sh:264-271` documents
  ("git does not copy node_modules into a new worktree… Run it HERE, in this worktree").

The shipped tooling models only the sibling case. `docs/git-workflow.md`'s "A fresh worktree needs its
own `pnpm install`" is true there and false for the nested one.

### 2.3 L0's drift check never looks at the worktree

`templates/ai-hook.sh`:

```sh
15: ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
16: BIN="$ROOT/node_modules/.bin/$BIN_NAME"
80: WP_MANIFEST="$ROOT/node_modules/@webpieces/$WP_NAME/package.json"
```

`.claude/settings.json` invokes the shim as `sh "$CLAUDE_PROJECT_DIR/.claude/webpieces/ai-hook.sh"`,
so `$0` — and therefore `$ROOT` — **is `$CLAUDE_PROJECT_DIR`**, fixed at session start and immune to
any `cd`. Faults **D / X / U / K** compare `$ROOT/package.json` against `$ROOT/node_modules`, and the
bin that is executed is `$ROOT`'s.

The payload `cwd` is parsed (`ai-hook.sh:100-101`) and used for **exactly one thing**: picking the log
directory. Not for the drift check.

Meanwhile L1 (the JS side, and L0's own S/C/Y faults) resolves the tree **per call** from the payload
`cwd`. So the two halves of the same hook can disagree about which tree they are in, on the same call.
That split is what burned five no-op installs in the incident recorded at
`coordinator-worktree.ts:40-47`.

### 2.4 `.claude/worktrees/` is hidden from git by a LOCAL, uncommitted rule

```
$ git check-ignore -v .claude/worktrees
.git/info/exclude:11:**/.claude/worktrees/	.claude/worktrees
```

`.git/info/exclude` is not committed and not distributed. A consumer repo that never received that
line sees every subagent worktree as untracked files — in `git status`, in `wp-*` dirty-tree checks,
and in anything that reasons about a clean tree.

### 2.5 Appends tear above 512 bytes

`O_APPEND` writes are indivisible only under `PIPE_BUF`, which is **512 bytes on macOS**
(`state-dir.ts:85`, `branch-mutation-log.ts:82`). Several real log lines exceed it — a
`REAP_WORKTREE … recover=git worktree add -b <branch> <abs-path> <tag>` line with real paths does.
This is why per-writer log isolation is a correctness requirement, not tidiness.

### 2.6 A hook that fails to LAUNCH is a silent ALLOW — the whole system's soft underbelly

Documented at https://code.claude.com/docs/en/hooks.md, and the most safety-critical fact in this file:

| hook process exit | Claude Code's behaviour |
|---|---|
| `0` | stdout parsed for JSON; **no decision → normal permission flow** |
| `2` | **blocking error** — stderr is fed to Claude as the block reason, the call is prevented |
| **anything else** (`1`, `126`, `127`, …) | **"Non-blocking error. Execution continues; the action proceeds."** |

and explicitly: **"File missing or not executable: Error logged; tool proceeds."**

So if the hook **command cannot start at all**, the tool call runs **with no guards**, and nothing is
surfaced to the AI or the user. We never produce that state deliberately — `2` is our block channel and
`0` carries the JSON decision — but a bad hook *path* produces it every time.

Two consequences that constrain every design in these docs:

1. **The hook entry point must be unconditionally resolvable.** This is why the entry point is
   `$CLAUDE_PROJECT_DIR`-absolute today, and why [0003](0003-three-hooks-per-tree-governance.md) keeps
   one absolute hook even while moving the real work to relative ones — see 0003 §4.
2. **`exec`ing another script from the shim is unsafe.** POSIX `exec` on a missing target exits 127 and
   therefore ALLOWS. The current shim deliberately runs the binary as a child, captures `rc`, and maps
   anything outside `{0,2}` onto fault K so it fails CLOSED (`ai-hook.sh:94-95, 151-177`). This is also
   one of the three findings that killed the bridge design (0003 §6).

---

## 3. The 12-agent scenario

One clone, 4 coordinators, 2 subagents each = 12 concurrent agents; say 1 in the primary and 11 in
worktrees. Requirement: **12 separate log files, in one place, timestamp-correlatable** so we can see
agents stepping on each other.

| approach | keying | result |
|---|---|---|
| today | git worktree name only | two agents sharing a tree share one file → torn appends (§2.5); nothing distinguishes them |
| PR #579 alone | `<tree>/logs/agents/<agentId>/` | scattered across 12 tree dirs, **and all 4 coordinators collide** — see §3.1 |
| state move alone | `~/.webpieces/<flat-repo>/logs/` | one place ✅, but 12 agents still tearing one file |
| **#579 + state move + `session_id`** | `~/.webpieces/<flat-repo>/logs/sessions/<sessionId>/<agentId\|coordinator>/` | **12 files, one place ✅** |

Neither change alone satisfies the requirement. They compose.

### 3.1 `agent_id` alone is NOT enough — four coordinators collide

`agent_id` is present **only inside a subagent**; its absence is exactly how `AgentIdentity.coordinator`
is derived (`coordinator-worktree.ts:14-25`). So **four independent Claude Code sessions on one clone
are four coordinators with no `agent_id` between them** — four processes appending to one file named
`coordinator`. Real log lines exceed macOS's 512-byte `PIPE_BUF` (§2.5), so those appends tear.

**The discriminator is `session_id`** — a common field on every hook event, alongside `cwd`,
`transcript_path` and `permission_mode`. It is **not parsed today**: `hook-core.ts` reads
`agent_id`/`agent_type` and nothing else identity-shaped.

So the key is `session_id` + `agent_id`:

```
logs/sessions/<session_id>/<agent_id | "coordinator">/<same filenames>
```

4 sessions × (1 coordinator + 2 subagents) = 12 distinct paths, no collisions — and the session grouping
is itself the unit a human debugs. **PR #579 keys on `agent_id` only and therefore carries this
collision**; adding `session_id` is a small targeted change to it, not a redesign.

Note the two identities are independent and both are needed: the **tree** says which release and which
branch state govern; the **agent** says which file to append to. Keying logs by tree alone loses agents
that share a tree; keying by agent alone loses which tree the line was about. The `tree=` /
`root=` / `projectDir=` columns already in every audit line are what keep the tree visible after the
directory stops encoding it.

---

## 4. Decisions

### Taken

**D1 — State moves out of the repo, to `~/.webpieces/<flattened-absolute-primary-path>/`.**

> **STATUS: NOT IMPLEMENTED — the one thing that shipped under it has been REVERTED (2026-08-07).**
> Briefly, the gated squash-commit body was written outside the repo at
> `~/.webpieces/prs/<host>/<owner>/<repo>/<prNumber>/merge-commit-body.md`. That store is DELETED, and
> so is the `MachineStateHome` resolver that located it — see
> [0005](0005-the-pr-description-is-the-merge-body.md). **There is no machine-global resolver to reuse;
> a future mover would have to write one.** Everything webpieces writes — `merged-branches.json`, the
> main-sync pair, `merge-info/`, `pr-review/`, the logs, and now the merge body's temp file — is inside
> the clone under `DotWebpieces`.


Key is the primary clone's absolute path with `/` → `-`, the same scheme Claude Code uses for its own
scratchpad (`-Users-deanhiller-workspace-onetablet-monorepo-nx1`). Rationale: both file-scoped guards
open with `if (ctx.relativePath.startsWith('..')) return []`
(`feature-branch-guard.ts:56`, `read-stale-guard.ts:98`), so a path outside the workspace root is not
fail-open — the guard **never acquires jurisdiction**, before any `git rev-parse` runs. That is the
structural version of a policy the Bash side already implements by hand
(`content-read-scan.ts:149-155`: *"`.webpieces/` is the guards' own logs/caches — orientation data
this guard writes itself, not source that upstream has moved past"*).

Secondary wins: `git clean -xdf` stops destroying in-flight merge state; consumers stop needing a
`.gitignore` entry; state survives `git worktree remove`.

**D2 — The key is the flattened path, NOT the repo basename.** *(Scope note, revised 2026-08-07: the PR
merge body was briefly keyed by the REMOTE instead, as the one artifact whose identity was bigger than a
clone. That store is GONE — GitHub holds the merge body now, see
[0005](0005-the-pr-description-is-the-merge-body.md) — and with it the only artifact that was ever keyed
by anything other than the tree. D2 governs clone state and nothing else contests it.)*
 Basenames collide (`api`, `web`,
`monorepo`, and `monorepo-nx` vs `monorepo-nx1`). A collision means two repos sharing
`merged-branches.json` and `main-sync-status.json` — precisely the "N divergent truths" failure
`state-dir.ts:59-66` was written to kill, inverted. Not the git remote URL either: two clones of one
repo have different branches and worktrees and must not share.

Flattening also has to be computable in POSIX `sh` for the shim twin — `tr '/' '-'` is; portable
hashing is not (`shasum` / `sha1sum` / `cksum` availability varies).

**D3 — `WEBPIECES_STATE_HOME` is a full override, not a prefix.**

> **WITHDRAWN (2026-08-07). The env var, `MachineStateHome` and `StateHome` are DELETED — there is no
> code left that could read an override.** See [0005](0005-the-pr-description-is-the-merge-body.md).
>
> D3 was never a decision in its own right; it was the *escape hatch* for D1's move out of the repo, and
> it only ever shipped for one artifact — the gated PR merge body. That artifact now lives on the PR,
> which means there is nothing outside `{repo}/.webpieces` to redirect, so an override would be a knob
> with no reachable effect. Every reason D3 gave for existing (a sandbox with no writable `$HOME`,
> "put it back in the tree") is now the DEFAULT rather than an opt-out: state is in the tree.
>
> Its two implementation findings are worth keeping if anything ever moves out again: read `$HOME` from
> the ENVIRONMENT before `os.homedir()` (on macOS `os.homedir()` falls back to the password database, so
> preferring it both ignores a deliberately scrubbed environment and makes `HOME=<tmp>` untestable), and
> probe writability by actually creating the directory and writing a marker (a read-only mount, a
> sandbox denial and a permission error all present differently in `stat` and identically to a write).

*Original text, for the record:* Point it at a directory and that
directory *is* the state root for that repo, with no `<key>` nesting. Needed as the escape for
containers/sandboxes with no writable `$HOME`, and as "put it back in the tree" for anyone who wants
that. Fall back to `<primary>/.webpieces` when `$HOME` is missing or unwritable — this is on the hook's
blocking path and must never throw.

**D4 — Hard cut, no compatibility reads.** Per CLAUDE.md § "webpieces.config.json is NEVER released
backwards-compatible", the new location is the only location. **But not silent:** if
`<primary>/.webpieces/` still exists, fail loudly once naming the destination ("state moved to
`~/.webpieces/<key>` — move or delete `<primary>/.webpieces/`"). Never read it, never merge it. That is
a signpost, not a fallback, and it is what stops an upgrade mid-3-point-merge from silently losing
`merge-in-progress.json`.

**D5 — Per-agent log split lands FIRST, via PR #579.** It is done, green and MERGEABLE; it adds
`DotWebpieces.agentLogs()` + `agentDirName` and the concurrency/traversal specs. D1 rewrites the same
two files (`state-dir.ts`, `shim-audit-log.ts`) and is far easier to write on top of `agentLogs()` than
to retrofit under it. It is also the *stabilising* change of the two — nothing reads `.log` files
programmatically, whereas D1 relocates in-flight merge state.

**D6 — The shim's tree resolution is fixed with D1, not after.** Today `_wp_primary` (§2.1) only feeds
a log path and the filesystem quietly resolves the `..` segments, so the damage is one stray in-repo
directory. Under D1 `_wp_primary` **becomes the identity**: `/…/primary/sub/deep/../..` flattens to
`-…-primary-sub-deep-..-..`, a different key from the TS twin's — and a different one again for every
subdirectory a hook ever fires from. Cosmetic becomes load-bearing.

**D7 — WITHDRAWN the same day it was taken (2026-08-06). Superseded by
[0002-the-shim-cannot-follow-the-tree.md](0002-the-shim-cannot-follow-the-tree.md).**

> D7 said governance follows the effective tree. It cannot, as written: the committed shim that
> actually RUNS is always the primary's (§2.3), so measuring the worktree's install while executing
> the primary's shim re-creates the **two-tree straddle** that `shim.ts:479-502` records as a real,
> non-convergent incident — the cure re-fires the deny forever. The shim/binary pair must come from
> ONE tree. See 0002 for the problem statement and the candidate fixes.
>
> The text below is kept as the rejected proposal, because it is the one that will be re-proposed.

~~Faults D/X/U/K measure the tree the call actually acts on, and that tree's bin runs. The primary and
a worktree may legitimately sit on different `@webpieces` releases.~~

The effective tree is resolved exactly as L1 already resolves it: a leading literal `cd <path> &&` in
the command, else the payload `cwd`. Read/Write carry no command, so they use `cwd`.

**Installed-version detection walks up, because Node does.** This is what makes §2.2 honest without
forcing a full install into every subagent worktree:

- declared = `<effective tree>/package.json` — the branch's own pin
- installed = first `node_modules/@webpieces/<pkg>/package.json` found walking **up** from the
  effective tree, which is precisely what Node will resolve at runtime
- **equal → no fault.** A nested `.claude/worktrees/agent-X` on the same release keeps reusing the
  primary's `node_modules`, exactly as it does today. No new installs, no new cost.
- **different → fault D**, cured by `cd <tree> && pnpm install`, which materialises that tree's own
  `node_modules` and ends the silent walk-up.
- **nothing found → fault X/U**, unchanged (this is the sibling-worktree case).

Measuring the walk-up rather than one fixed directory is the whole trick: the fault fires if and only
if what Node will actually load disagrees with what the branch pinned.

**Trust boundary (the reason this was open).** The bin now comes from a tree named by the payload, so
the effective tree is accepted **only if it is the primary clone or a linked worktree of the same
repo** — `git --git-common-dir` must match `$ROOT`'s. Anything else (foreign repo, outside any repo)
falls back to `$ROOT`, which is today's behaviour.

**Fault S stays anchored at `$ROOT`.** S compares the *committed* `.claude/webpieces/ai-hook.sh`
against what the running release renders. That file belongs to the tree that owns it, and
`.claude/settings.json` always invokes the primary's copy, so S is about `$ROOT` by construction.
Two anchors, each governing the thing it actually owns: `$ROOT` for the shim file (S), the effective
tree for the installed release (D/X/U/K).

### Open

**O2 — Target-based jurisdiction.** Judge a file operation against the tree that OWNS the target path,
not the session `cwd`. Already filed as `guards/L1-location.md` § "Not done"; D1 fixes only the
artifact half. Explicitly out of scope for D1 — writes to
`<primary>/.claude/worktrees/agent-X/src/foo.ts` are still judged against the primary's branch after
D1 lands.

**O3 — Orphaned state dirs.** After D1, `rm -rf <clone>` no longer reaps its state. Plan: an
`origin.json` marker per key dir naming the primary path, and `cleanTmp` reaps keys whose primary no
longer exists. Gets strictly better than today — one sweep covers every repo, including ones you can
no longer `cd` into.

> **MOOT again as of 2026-08-07 — nothing is orphaned, because nothing is written outside a repo.**
> This was briefly live: each PR dir under `~/.webpieces/prs/` carried the planned `origin.json`, and
> `cleanTmp` swept that root on the same 30-day policy. Both are DELETED with the store itself (the
> gated merge body is the PR's own description now — see
> [0005](0005-the-pr-description-is-the-merge-body.md)), so `{repo}/.webpieces` is the only root and it
> dies with the clone that owns it. `AgedTreeSweeper` stays extracted, with one caller.
>
> O3 becomes live again the moment anything moves out of the repo, and the age-INDEPENDENT half — reap a
> key whose primary clone no longer exists — is still the unsolved part. Age alone was sufficient for PR
> bodies specifically; it is NOT sufficient for state that is rewritten indefinitely.

**O4 — `.claude/worktrees/` distribution (§2.4).** Should the ignore rule be committed rather than
living in `.git/info/exclude`? Affects consumers, not this repo.

---

## 5. Rejected

| option | why not |
|---|---|
| **Co-locate artifacts inside the agent's git worktree** (option 3 of the backlog bug) | Makes tooling output source-adjacent, needs a `.gitignore` *there*, and deepens the two-directories-called-worktree ambiguity instead of removing it. |
| **Exempt `.webpieces/**` inside each guard** | Correct and ~30 lines, but it is a carve-out every future file-scoped guard must remember to honour — and the family already has four. D1 makes it structural. Kept in mind as the fallback if D1 stalls. |
| **A symlink `<worktree>/.webpieces` → the real dir** | Already rejected once, for reasons that still hold — see `state-dir.ts:68-76`. `rename(2)` acts on the path, not the link, so atomic writes silently replace the symlink with a real file and diverge. |
| **Key state by git remote URL** | Merges two clones of the same repo, which have different branches, worktrees and in-flight merges. |
| **`cd … && pwd -P` to normalise git dirs in the shim** | Resolves symlinks; `path.resolve()` in the TS twin does not. Would re-introduce sh/TS divergence on symlinked repo paths. |
| **A compatibility read of the old state location** | Two answers to "where is the merge state", which is the failure `state-dir.ts` exists to end. Replaced by the D4 signpost. |

---

## 6. Where this is implemented

| concern | file |
|---|---|
| tree resolution (#1) | `packages/tooling/ai-hook-rules/src/core/effective-tree.ts` |
| release/version governance (#2) | `packages/tooling/ai-hook-rules/templates/ai-hook.sh` (`$ROOT`, lines 15-93), `src/bin/l0-allowlist.ts`, `src/core/l0-matrix.ts` |
| state dir (#3) | `packages/tooling/rules-config/src/state-dir.ts`, `state-dir-migration.ts`, `constants.ts:53` |
| agent identity (#4) | `packages/tooling/ai-hook-rules/src/core/coordinator-worktree.ts`, `src/adapters/hook-core.ts` |
| the decision tables | `GUARD_MATRIX.md` → `guards/L0-tooling.md` … `guards/L4-pr-lifecycle.md` |
