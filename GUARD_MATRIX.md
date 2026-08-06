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
> **Every other layer file is hand-written TODAY and is being converted to the same mechanism.** Each
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
| L1 | — | hand-written; conversion planned next |
| L2 | — | hand-written; conversion rides with the guard collapse |
| L3, L4 | — | stubs |

**How the generated files reach this repo's root, despite the one-release lag.** The runtime copy in
`.webpieces/instruct-ai/` comes from the PUBLISHED package and is therefore one release behind — fine
for consumers, wrong for the copy people read on GitHub. So the root files are **not** written by the
runtime hook. They are byte-locked by a vitest spec that calls the local `render*Doc()` — and vitest
resolves `@webpieces/*` to local source via `tsconfig.base.json` paths, so there is no lag at all. A
stale root doc fails `build-all`, exactly like `validate-architecture-unchanged`. No repo-detection
hack, and consumers keep getting the published copy at block time.

## The layers

| layer | goal — the question it answers | config key | doc |
|---|---|---|---|
| **L0** | Is webpieces itself trustworthy right now? | *(none — always on)* | [L0 — tooling integrity](guards/L0-tooling.md) |
| **L1** | Is this call ours to judge, and is git run from the root? | `location-guard` *(proposed)* | [L1 — location](guards/L1-location.md) |
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
the logs, or nobody can tell whether the guards are protecting anything or quietly abstaining. Today
that distinction is a **string suffix** (`… (fail-open)`) rather than a typed verdict, which is why the
abstentions are not countable.

## The invariant, and its dual

Every L2 guard, and most of L0, is built on one rule:

> **Never block on data you could not establish.**

It has a dual that is easy to miss, and missing it is how a collapse silently disarms a guard:

> **Never fail open on data you DID establish.**

Branch identity comes from one `git rev-parse` and is always establishable. Cache state often is not.
Order a table so the cache's fail-opens sit in front of a cache-free fact and the fail-open leaks onto
the fact. See L2's row 5 and the divider above it — that ordering is load-bearing.

### L-1: the layer below L0 — the hook must LAUNCH

Every layer above assumes the hook process ran at all. If it does not, the harness allows the call and
tells nobody. From the [hooks reference](https://code.claude.com/docs/en/hooks.md): exit `2` is the
blocking channel (stderr becomes the block reason), exit `0` carries the JSON decision, and **any other
exit is a "non-blocking error. Execution continues; the action proceeds"** — including
*"File missing or not executable: Error logged; tool proceeds."*

> **A hook that fails to launch is a silent ALLOW — not a block, not an error the AI sees.**

Nothing in this repo produces that state deliberately. A bad hook **path** produces it every time, which
is why the entry point in `.claude/settings.json` is `$CLAUDE_PROJECT_DIR`-absolute, and why the shim
runs the binary as a CHILD and maps any `rc` outside `{0,2}` onto fault K rather than `exec`ing it
(`ai-hook.sh:94-95, 151-177`) — `exec` on a missing target exits 127 and therefore allows.

Full treatment, including the proposal to move the real guards to relative per-tree hooks while keeping
one absolute hook for exactly this reason: [decisions/0003](decisions/0003-three-hooks-per-tree-governance.md) §4,
and [decisions/0001](decisions/0001-tree-identity-and-governance.md) §2.6.

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
