# L1 — location

**Goal: is this call ours to judge, and is git being run from the root?**

**Config key: `location-guard` (proposed).** Force-to-root has **no config key today** and cannot be
disabled; `excludePaths` is a top-level block, not a `hookGuards` entry.


**Code:** `packages/tooling/ai-hook-rules/src/core/effective-tree.ts` (`EffectiveTreeResolver`,
`TreeKind`) · `packages/tooling/ai-hook-rules/src/core/runner.ts` (`gitFromSubdirBlock`,
`filterByExcludedPaths`, the `foreign` check).

L1 answers two questions, and they are genuinely separate:

1. **Do we govern this at all?** — the escape hatches, for other repos and non-governed paths.
2. **Is the agent stranded away from the root?** — force-to-root, git/gh only. Agents forget where
   they are constantly, and `cd` gives them two different ways to be wrong: a `cd` that stays INSIDE
   the workspace PERSISTS to later calls (so the shell can be parked in a subdirectory left by an
   unrelated command turns earlier), while a `cd` that LEAVES it is reset by the harness, which says
   so — `Shell cwd was reset to <root>`. Neither can be assumed, which is why every remedy names the
   root explicitly instead of telling the agent to `cd` first.

## Preamble — resolve the target first (Bash only)

`EffectiveTreeResolver.resolve()` computes `effectiveCwd`: the directory the command actually runs in,
which is the shell's cwd unless the command leads with `cd <dir> &&`. **K is classified from
`effectiveCwd`, not from the shell's cwd** — so "a foreign repo that `cd`s into ours" is not a cell,
it is simply `pw` after resolution.

Only a LEADING run of `cd`/`pushd` counts. A *trailing* `… && cd <exempt-tree>` must never
retroactively pull a command out of scope — that would smuggle a root-level `git push` past the
guards. Quoting is handled by `ShellSegmentScan`, so `echo "cd sub && git push"` is one opaque
segment and its quoted `cd` is never picked up.

## Filter — not a dimension (all tools)

`filterByExcludedPaths` drops every rule excluded for this path: the **target path** for
Read/Write/Edit, `effectiveCwd` for Bash. An empty rule list means allow. This is a filter, not a row:
"exempt" is what emerges when the list empties.

`excludePaths` is **ONE glob list** (canonical: `"excludePaths": ["repositories/**"]`). The
`{ rules: [...], guards: [...] }` object is **retired and rejected**, with the union it must become
named in the error. `wp-install-ai-hooks` migrates it in place.

This used to be a tolerated fallback, justified here by "rejecting it would block every Bash/Edit
including the edit that would fix it." **That was never true**, and the fallback it licensed is why
consumer configs — this repo's own included — sat on the dead shape for releases. A Write/Edit whose
target is `webpieces.config.json` is an unconditional **PASS** (see the L0 table above), and
`pnpm install` has an installer bypass, so an invalid config can always be repaired from inside the
block. Config rejection is self-recoverable by construction; see `retired-config-keys.ts` for the
policy and the reasoning.

## Legend

| col | dimension | values |
|---|---|---|
| **K** | tree kind of the resolved target | `f` foreign repo · `o` outside any repo · `pw` ours (primary **or** worktree) |
| **G** | command invokes git/gh | `n` · `y` |
| **P** | position of the resolved target | `root` · `sub` |

All three are **Bash only**. Read/Write/Edit resolve their own target (`input.filePath`) and have no
dimensions — the filter is all that applies to them.

A linked worktree is deliberately **not** foreign: it is the same project, so the guards run against
THAT tree's branch and cache. `p` and `w` are never distinguished, hence `pw`.

## Table

| # | K | G | P | act | why |
|---|---|---|---|---|---|
| 1 | `f` | - | - | 2 exempt | different git repo — hands off |
| 2 | `o` | - | - | → L2 | see "Not done" below |
| 3 | `pw` | `n` | - | → L2 | force-to-root has no jurisdiction |
| 4 | `pw` | `y` | `sub` | 4 block | `cd <root> && <original>` |
| 5 | `pw` | `y` | `root` | → L2 | |

## L1 use cases

Same row shape as L0: the **Fix** is literal or it is not a fix. `<root>` is the absolute workspace
root — the messages name it explicitly rather than telling you to `cd` first, for the reason in the
section head (neither the shell's cwd nor a `cd`'s persistence can be assumed).

| # | what you SEE (exact symptom) | state (K/G/P) | verdict | Fix |
|---|---|---|---|---|
| 1 | `cd repositories/vendored && git commit` goes through untouched | `f` / `y` / - — row 1 | ALLOW_EXEMPT | none needed — jurisdiction is judged on the RESOLVED target, after the `cd`; a different git repo is hands-off |
| 2 | Edit `repositories/vendored/foo.ts` allowed even on stale main | filter — the path is in `excludePaths` | ALLOW_EXEMPT | none needed |
| 3 | Edit `packages/http/foo.ts` blocked on stale main | filter keeps the rules → L2 fires | BLOCK (at L2) | that is L2's write-on-main verdict, not L1's — follow the L2 message |
| 4 | Edit `packages/http/foo.ts` judged even though the shell is in `/tmp` | filter, on the TARGET path | → L2 | none — for file tools the cwd is irrelevant; do NOT `cd` anywhere to "fix" it |
| 5 | `ls` from `packages/http/` runs normally | `pw` / `n` / - — row 3 | → L2 | none — force-to-root has no jurisdiction over non-git commands |
| 6 | `pnpm test` from `packages/http/` runs normally | `pw` / `n` / - — row 3 | → L2 | none — deliberately untouched, so package-local test runs stay natural |
| 7 | `git status` from `packages/http/` is blocked | `pw` / `y` / `sub` — row 4 | BLOCK | Option 1 (preferred): `cd <root> && git status` |
| 8 | `cd packages/http && git status` **typed from the root** is blocked | `pw` / `y` / `sub` — row 4 | BLOCK | Option 1 (preferred): `cd <root> && git status`<br>Do NOT: assume it is allowed because you started at the root — the predicate is `effectiveCwd === root`, i.e. the DESTINATION |
| 9 | `cd <root> && git status` passes from anywhere | `pw` / `y` / `root` — row 5 | → L2 | none — this IS the prescribed cure |
| 10 | `echo "cd sub && git push"` passes | `pw` / `n` / `root` — row 3 | → L2 | none — the `cd` is inside quotes, so `ShellSegmentScan` never treats it as a scope escape |
| 11 | `cd <subdir> && git push` blocked with the force-to-root message, NOT the gated-flow one | `pw` / `y` / `sub` — row 4; force-to-root runs first | BLOCK | Option 1 (preferred): `cd <root> && git push`, which then gets the push guard's real answer ← costs one extra turn by design; still blocked |

Row 8 is the one that changed. It used to be ALLOWED, because the predicate was
`shellAtRoot || cdsToRoot` — two variables OR'd, so the same destination got opposite verdicts
depending on where the shell happened to start. It is now one variable, `effectiveCwd === root`.

## Not done — `o` is not exempt yet

Row 2 hands `'outside'` down to L2 rather than exempting it. `'outside'` is produced at
`effective-tree.ts` (`gitRoot === null`) carrying `governedRoot`, and **no code branches on it**, so a
command in no git repo is judged against the governed repo's branch and staleness state. That is a
wrong verdict, and `exempt` is the right action.

**It must not ship alone.** Jurisdiction comes from the shell cwd, not from what the command touches,
so exempting `o` opens a bypass an agent reaches by typing `cd /tmp &&`:

| command | today | with `o → exempt` alone |
|---|---|---|
| `cd /tmp && ls` | judged against the repo | exempt — **correct** |
| `cd /tmp && git -C $REPO commit` | L2 guards fire | exempt — **every L2 guard bypassed** |
| `cd /tmp && rm -rf $REPO/packages/http/src` | judged | exempt — **unguarded** |

The two cases only separate once jurisdiction is judged on **what the command touches** (explicit
`git -C` / `--work-tree`, then path arguments, then the `cd`, then the shell cwd), with the fail-safe
rule that **any** resolved target inside `governedRoot` means `pw`. Ship the two together, or neither.

Tracked in `backlog/bug-bash-guards-judge-the-shell-cwd-not-the-paths-the-command-touches.md` and
`backlog/bug-outside-tree-kind-is-never-consumed-so-a-non-git-dir-is-judged-against-the-governed-repo.md`.
That resolver has three consumers — L1's K, L2's scope dimension, and `excludePaths` on the Bash path
— which is why the backlog says **fix once**.

---


## Code anchors

| section | file | symbol |
|---|---|---|
| resolver, K | `ai-hook-rules/src/core/effective-tree.ts` | `EffectiveTreeResolver`, `TreeKind` |
| force-to-root | `ai-hook-rules/src/core/runner.ts` | `gitFromSubdirBlock` |
| the filter | `ai-hook-rules/src/core/runner.ts` | `filterByExcludedPaths` |
| `excludePaths` shape | `rules-config/src/exclude-hook-paths.ts`, `validate-config.ts`, `retired-config-keys.ts` | `ExcludePaths`, `validateExcludePaths` |
