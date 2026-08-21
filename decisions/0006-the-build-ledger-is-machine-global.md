# 0006 — The build ledger is machine-global, because the fact it records is

**Status:** taken and implemented (`~/.webpieces/builds.log`)
**Measured:** 2026-08-20, macOS (darwin 25.3.0)
**Relates to:** [0004](0004-pr-artifacts-are-machine-global.md) (the rule it applies),
[0005](0005-the-pr-description-is-the-merge-body.md) (which retired 0004's implementation)
**Where:** `packages/tooling/rules-config/src/builds-log.ts`,
`packages/tooling/rules-config/src/home-config.ts` (`experimental.maxConcurrentBuilds`),
`packages/tooling/pr-gate/src/scripts/workflow/build-affected.ts` (the one instrumented choke point),
`packages/tooling/pr-gate/src/scripts/commands/build-command.ts` (the refusal)

---

## 1. The standing rule this appears to break

`packages/tooling/rules-config/src/no-machine-global-state.spec.ts` opens with:

> There is EXACTLY ONE place webpieces writes state: `{repo}/.webpieces`.

That is a real rule with a real test behind it, and this change adds a writer to `~/.webpieces/`. So it
has to be argued, not slipped past.

## 2. What the rule was actually written about

The rule came out of 0005, which retired `MachineStateHome` / `StateHome` / `PrBodyStore` — a
machine-global store of the **gated squash-commit body**. Two things killed it:

1. **It was a CACHE of a fact the remote owned.** The PR description on GitHub is the merge body. A
   local copy of it can be missing (a fresh clone), stale (the PR was edited), or on the wrong computer
   (a colleague lands your PR). Every one of those is a wrong answer that looks like a right one.
2. **Its key was never stable.** `<host>/<owner>/<repo>` derived the first segment from however `origin`
   happened to be spelled, so an ssh alias and a full hostname keyed one repo to two directories.

Both faults are properties of **that artifact**, not of the location. 0004's underlying rule —
*key an artifact by the scope of the fact it describes* — survived 0005 intact and is the rule being
applied here, not the one being broken.

## 3. Why the build ledger is the opposite case on every count

The question the ledger answers is: **how many builds are burning this machine's CPU right now?**

| 0005's failure mode | `builds.log` |
|---|---|
| a cache of a remote fact | not a cache — there is no remote copy. The file IS the fact. |
| can be stale or missing | a missing file means "no builds recorded", which is the correct answer for a machine that has not built |
| can be on the wrong computer | it is *about* this computer. It is meaningless anywhere else, and it never leaves. |
| unstable key | keyed by absolute local path — stable precisely because it never travels |
| read-modify-write over a shared file | append-only; rows are under `PIPE_BUF` so a single `O_APPEND` write is indivisible |

## 4. Why a per-repo file cannot answer this question at all

This is the load-bearing half, and it is not a preference.

The contention we are measuring is **between agents in different trees**. On this box that routinely
means several linked worktrees of one repo plus several other repos. `{repo}/.webpieces` is
worktree-namespaced — every linked worktree has its own state directory — so a per-repo ledger written
by a build in worktree A is invisible to a build starting in worktree B thirty seconds later, and
invisible to the other four repos entirely.

A per-repo ledger would therefore report "0 builds running" on a machine running four. It is not a
weaker answer to the question; it is an answer to a different question nobody asked.

Scoping the file to the machine is the same move 0004 made and 0005 upheld: **the artifact goes where
the fact lives.** The fact here is machine-scoped, so the file is.

## 5. The carve-out, stated narrowly

State may live under `~/.webpieces/` when **all** of these hold:

1. The fact is **inherently machine-scoped** — no repo, worktree or remote owns it.
2. It is **not a cache** of anything another system holds authoritatively.
3. Its key never has to travel between machines.
4. Losing the file degrades to a safe default rather than a wrong answer.

`builds.log` meets all four. `PrBodyStore` met none of them. Anything proposed for this directory in
future is argued against these four points, in a numbered decision doc, or it does not go there.

`no-machine-global-state.spec.ts` keeps every assertion it had — `MachineStateHome`, `StateHome`,
`WEBPIECES_STATE_HOME`, `PrBodyStore` and friends stay dead, by name, and no source file may read a
state-home env override. Only its docblock is amended, to name this carve-out so the next reader finds
the argument instead of re-deriving it or quietly widening the rule.

## 6. What is actually written, and what reads it

Three row kinds, TSV, one line each, deliberately under 512 bytes (macOS `PIPE_BUF`) so a single
`O_APPEND` write cannot tear:

```
START<TAB>id=<uuid><TAB>t=<iso><TAB>ms=<epoch><TAB>by=<stage><TAB>repo=…<TAB>tree=…<TAB>cwd=…<TAB>branch=…<TAB>pid=…<TAB>wp=<version>
DONE-SUCCESS<TAB>id=<uuid>…<TAB>took=<ms><TAB>pid=…
DONE-FAIL<TAB>id=<uuid>…<TAB>took=<ms><TAB>exit=<n><TAB>pid=…
```

- **`id`** pairs a START with its DONE. **`pid`** says whether an unpaired START is still real — a build
  killed with SIGKILL writes no DONE row, and without the liveness test its START would wedge the count
  at the limit forever.
- **`by`** is the caller: `build` | `review` | `finish`. That is `BuildGateOptions.stage`, which already
  existed and is already required. A second `caller` field would be two spellings of one fact.
- **`cwd`** rather than an agent id: there is no trustworthy agent/subagent marker on this box
  (`CLAUDE_CODE_CHILD_SESSION=1` appears even in a coordinator session), so the ledger records only facts
  that are true — cwd, tree, pid — and guesses at no identity.
- **`wp`** is the release actually executing, found by walking UP from `__dirname` to the enclosing
  `node_modules/@webpieces/<pkg>/package.json`. This is deliberately NOT
  `WebpiecesVersions.readInstalled(root)`, which joins at a fixed root *on purpose* so it can detect pin
  drift between trees; a walk-up there would hide exactly the skew that guard exists to catch. Two
  questions, two implementations, and neither should be folded into the other.

Rotation is 1 MB × 5 generations, performed inside the lock — the rename-and-reopen is the part that
genuinely races, and it is why the lock exists at all.

## 7. One choke point, and the side doors deleted

`BuildAffected.runBuildGate` is the only place a build is spawned, so instrumenting it covers every
build. It did not used to be: `runBuildAffected` and `runConfiguredBuildGate` were public and each
spawned `buildCommand` with no caller identity and no ledger row. They are folded into one private
method, so an unlogged build no longer compiles — the one-spelling rule applied to a behaviour rather
than to a type.

## 8. The refusal, and why only `wp-build` gets it

At `experimental.maxConcurrentBuilds` (default 3) live builds, **`wp-build`** refuses and hands back the
list, with the gate flow as the preferred cure and `pnpm wp-build --force` as the last option.

The gate stages (`wp-review-upsert-pr`, `wp-finish-upsert-pr`) **never** refuse. They are the sanctioned
path, and blocking them wedges a PR that has nowhere else to go. Their builds still write rows and still
count toward what refuses an ad-hoc `wp-build` — the thing throttled is the extra build, never the one
the process needs.

`--force` skips the count check and nothing else. The command run is byte-for-byte identical, so the
invariant that makes `wp-build` worth trusting ("it runs `buildCommand` verbatim, no legs, no knobs")
is untouched.

## 9. Rejected options

- **A per-repo `builds.log`.** § 4 — it cannot see the sibling worktree it is contending with.
- **A lock file instead of a ledger.** A lock answers "may I build" and nothing else; it cannot answer
  "what has this machine been doing", which is half the reason to write anything down.
- **An OS-level process scan** (`pgrep nx`, parsing `ps`). Platform-specific guessing that cannot tell a
  gate build from a stray one, cannot attribute a build to a tree, and leaves no history.
- **Refusing on the gate stages too.** Wedges the only path a blocked PR has out.
- **A `caller` field beside `stage`.** Two spellings of one fact; an automatic review reject.
- **An env var pointing the ledger elsewhere.** That is `WEBPIECES_STATE_HOME` under a new name, and it
  is exactly what 0005 killed. `homeDir` is a defaulted *parameter* on every method instead, which lets
  specs use a temp directory without any release honouring an override.
