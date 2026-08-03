# Guard decision matrices — index

The webpieces PreToolUse guards are layered. Each layer is an **ordered pattern list** — first match
wins, exactly like the if/else chains the code already is.

This file is the index. Each layer has its own document, because one file grew past the point where
anyone could find anything in it.

> **These documents are hand-written and CAN go out of date.** The code is the authority. Every layer
> file names the exact files and functions it describes, and those functions carry a comment pointing
> back. If the two disagree, **the code wins and the document is the bug** — fix it in the same PR that
> changed the behaviour.
>
> One exception: L0's fault table and allowlist are also **generated** from the arrays the guard
> actually consults, and that copy cannot drift. See [L0](guards/L0-tooling.md).

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
the fact. See L2 table A, row A1 — that ordering is load-bearing.

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
