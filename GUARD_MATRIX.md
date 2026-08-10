# Guard decision matrices — index

The webpieces PreToolUse guards are layered. Each layer is an **ordered pattern list** — first match
wins, exactly like the if/else chains the code already is.

This file is the index. Each layer has its own document, because one file grew past the point where
anyone could find anything in it.

> **Where these documents come from — and where they are going.**
>
> L0's fault table and allowlist are **generated** from the arrays the guard actually consults, and a
> unit test byte-locks the rendered file, so that copy cannot drift.
>
> L1's table, its use cases and their cures are generated and byte-locked the same way, from `L1_ROWS`.
>
> **Every remaining layer file is hand-written TODAY and is being converted to the same mechanism.** Each
> layer becomes an ordered array of row objects in code — tools, state, action, cure, and the use cases
> that exercise the row — the doc is rendered from that array, and a test locks the two together. The
> array is the thing the guard consults, so the doc cannot describe a guard the code does not implement.
>
> Until a layer is converted, its file is hand-written and CAN go out of date. The code is the
> authority; every layer file names the files and functions it describes, and those functions carry a
> comment pointing back. **If the two disagree, the code wins and the document is the bug** — fix it in
> the same PR that changed the behaviour.

## Generation status

| layer | source of truth | doc |
|---|---|---|
| L0 | `L0_FAULTS` + `L0_ALLOWLIST` | **generated, byte-locked** |
| L1 | `L1_ROWS` | **generated, byte-locked** — regenerate with `pnpm guards:generate` |
| L2 | — | hand-written; conversion rides with the guard collapse |
| L3, L4 | — | stubs |

For a converted layer the split is: **row data** lives in the array, **prose** lives as literal lines
inside the renderer, and there is no third place. The byte-lock spec fails on any hand edit, and
`pnpm guards:generate` rewrites the file from the array — never hand-edit a generated doc.

**How the generated files reach this repo's root, despite the one-release lag.** The runtime copy in
`.webpieces/instruct-ai/` comes from the PUBLISHED package and is therefore one release behind — fine
for consumers, wrong for the copy people read on GitHub. So the root files are **not** written by the
runtime hook. They are byte-locked by a vitest spec that calls the local `render*Doc()` — and vitest
resolves `@webpieces/*` to local source via `tsconfig.base.json` paths, so there is no lag at all. A
stale root doc fails the affected build, exactly like `validate-architecture-unchanged`. No repo-detection
hack, and consumers keep getting the published copy at block time.

## The layers

| layer | goal — the question it answers | config key | doc |
|---|---|---|---|
| **L0** | Is webpieces itself trustworthy right now? | *(none — always on)* | [L0 — tooling integrity](guards/L0-tooling.md) |
| **L1** | Is this call ours to judge, are the versions in sync, and is git run from the root? | `location-guard` *(proposed)* | [L1 — location](guards/L1-location.md) |
| **L2** | May I work here, and is what I read current? | `branch-state-guard` *(proposed)* | [L2 — branch state](guards/L2-branch-state.md) |
| **L3** | Which dead branches and worktrees get reaped? | `branch-cleanup-guard` *(proposed)* | [L3 — branch cleanup](guards/L3-branch-cleanup.md) |
| **L4** | Does every merge and PR go through the gated flow? | `pr-lifecycle-guard` *(proposed)* | [L4 — PR lifecycle](guards/L4-pr-lifecycle.md) |

**L0 has no config key on purpose.** If L0 is off, nothing downstream can be trusted — you would be
configuring the guards with a config file the validator could not check.

The other four keys are **proposed, not shipped**. Today `hookGuards` carries one key per implementation
CLASS (nine of them); the proposal is one key per POLICY (four). Each layer file names its own mapping.
The reason to collapse is in L2: half a policy is representable today, and that is precisely what
produced the inconsistencies documented there.

## Action codebook

| # | action | meaning |
|---|---|---|
| 1 | `ALLOW` | in scope, nothing wrong |
| 2 | `ALLOW_EXEMPT` | out of scope by construction |
| 3 | `ALLOW_FAIL_OPEN` | state could not be established; allow and log |
| 4 | `BLOCK_AI_CURE` | blocked; the AI can run the printed cure itself |
| 5 | `BLOCK_HUMAN` | blocked; needs a human decision |

Keeping 3 distinct from 1 is the point: a fail-open allow and a real allow must not look identical in
the logs, or nobody can tell whether the guards are protecting anything or quietly abstaining.

**This codebook is now a TYPE** — `Verdict` in `packages/tooling/ai-hook-rules/src/core/decision-log.ts`
— and it is what every layer writes to its log. It replaced `'ALLOW' | 'BLOCK'`, under which action 3
was a string SUFFIX (`… (fail-open)`) and actions 1 and 2 were indistinguishable. `'BLOCK'` was deleted
rather than aliased, so every construction site had to say which kind of block it meant.

Note what action 1 does NOT mean. A layer writing `ALLOW` is saying *it* had no objection and handed
the call down — never that the call ran. Claude Code can still refuse a call every layer allowed, and a
second PreToolUse hook running in PARALLEL cannot see this one's verdict. What is no longer true is that
a hook could OVERTURN another's allow: only the guards hook judges a `Bash` call, so `calls/` plus the
per-layer streams are the whole record and there is no join to perform.

(**Where those logs are:** [`docs/tooling-logs.md`](./docs/tooling-logs.md) — one directory per git
tree, then one directory per LAYER, then one file per concurrent writer. `ls logs/L1-location/` is
every L1 decision; each line carries `row=`, the row number this matrix prints.)

## The invariant, and its dual

Every L2 guard, and most of L0, is built on one rule:

> **Never block on data you could not establish.**

It has a dual that is easy to miss, and missing it is how a collapse silently disarms a guard:

> **Never fail open on data you DID establish.**

Branch identity comes from one `git rev-parse` and is always establishable. Cache state often is not.
Order a table so the cache's fail-opens sit in front of a cache-free fact and the fail-open leaks onto
the fact. See L2's row 5 and the divider above it — that ordering is load-bearing.

## The launch guarantee — structural, not a layer

Every layer above assumes the hook process ran at all. If it does not, the harness allows the call and
tells nobody. From the [hooks reference](https://code.claude.com/docs/en/hooks.md): exit `2` is the
blocking channel (stderr becomes the block reason), exit `0` carries the JSON decision, and **any other
exit is a "non-blocking error. Execution continues; the action proceeds"** — including
*"File missing or not executable: Error logged; tool proceeds."*

> **A hook that fails to launch is a silent ALLOW — not a block, not an error the AI sees.**

A bad hook **path** produces that state every time, and that is what shapes the registration:
`.claude/settings.json` carries **two** hooks, and **both are absolute**.

| hook | path |
|---|---|
| guards `ai-hook.sh wp-ai-guards-hook` | **absolute** `$CLAUDE_PROJECT_DIR/…` |
| rules `ai-hook.sh wp-ai-rules-hook` | **absolute** `$CLAUDE_PROJECT_DIR/…` |

An absolute path resolves from ANY cwd, so the guarantee is a property of the registration rather than
of a guard that has to defend it. **There is no L-1 and no `cd` guard: a `cd` into a project
subdirectory is simply ALLOWED.**

**Why the relative registration is gone (MEASURED 2026-08-10).** The guards and rules hooks used to be
registered RELATIVE, so that each git tree would run its own release, binary and pin, with an absolute
third hook (`guarantee-root.sh`, "L-1") denying every `cd` that could park the shell where a relative
path fails to resolve. It never delivered the per-tree governance it was paying for. A linked worktree
has no `node_modules` of its own, so `ai-hook.sh`'s upward walk always found — and executed — the MAIN
tree's binary; `readlink -f` on a worktree agent's bin resolved to
`<primary>/node_modules/@webpieces/ai-hook-rules`. A worktree ran its own SCRIPT and its own CONFIG,
never its own release. **Governance was always the primary's**, so the whole guard layer defended a
fiction, and its price was that no agent could `cd` anywhere inside the repo.

`guarantee-root.ts`, its spec, its template and the `L-1-cd/` log stream are deleted with it. The
managed surface is now **three** things — the committed `.claude/webpieces/ai-hook.sh`, the two
`settings.json` registrations, and the `settings.json` `env` entry
`CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR=1` (which pins the Bash cwd to the project root and, `env`
being inherited, pins it identically for every subagent). All three are compared against the installed
release by fault `S`, and `pnpm exec wp-upgrade-shim` regenerates all three.

The shim also runs the binary as a CHILD and maps any `rc` outside `{0,2}` onto fault K rather than
`exec`ing it — `exec` on a missing target exits 127 and therefore allows.

What replaced the per-tree ambition is **L1 row 8, `trinary-version-skew`**
(`core/version-sync.ts`, `core/webpieces-versions.ts`): one governor, and a BLOCK when a command or a
file edit targets a linked worktree whose `@webpieces` pin disagrees with the main tree's. Its cure is a
git cure — the pin is TRACKED, so the same hash gives the same pin: `git pull` both trees onto the same
main and run ONE `pnpm install` in the MAIN tree, or work in the main tree, or, if a tree genuinely
needs a different version, use a separate CLONE. A clone gets its own `node_modules` and its own
governance; a worktree borrows and cannot.

Full treatment: [decisions/0003](decisions/0003-three-hooks-per-tree-governance.md) (superseded — it is
the decision being reversed), and [decisions/0001](decisions/0001-tree-identity-and-governance.md) §2.6
for the silent-ALLOW measurement, which stands.

## The global allowlist

One list, consulted **before every layer**: commands that are inert (cannot read repo content, cannot
change the repo) plus the universal cures that must stay reachable or a session deadlocks. Detailed in
[L2](guards/L2-branch-state.md), because that is where the collapse builds it, but it is not L2's — it
precedes L0.

## Two rules that constrain every guard change

**The one-release lag.** The PreToolUse hooks and the `wp-*` bins run the PUBLISHED `@webpieces/*` from
`node_modules`, which trails local source. Verify guard changes with the package's own vitest suite
(tsconfig paths resolve to local src), never by watching live guard behaviour. Source and the config
that uses it ship in SEPARATE PRs.

**Config shape changes are a hard cut, never a fallback.** See the `webpieces.config.json` section of
`CLAUDE.md`. A moved or renamed key is REJECTED with an error naming the destination, recorded in
`packages/tooling/rules-config/src/retired-config-keys.ts`. No `?? legacyKey`, no alias table. This is
safe because every reader of the config is a coding agent, and because editing the config and running
`pnpm install` are always permitted even while the config is invalid — so a rejection cannot wedge a
repo. "Rejecting it would deadlock the consumer" is the argument that previously licensed fallbacks
which then kept this repo's own config on dead shapes for releases.
