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
| L-1 | `bin/guarantee-root.ts` (`renderGuaranteeRoot`) | hand-written — the table below; the SCRIPT is generated + byte-locked |
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
| **L-1** | Will the guard hooks LAUNCH at all after this `cd`? | *(none — always on)* | below, and [decisions/0003](decisions/0003-three-hooks-per-tree-governance.md) |
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
the logs, or nobody can tell whether the guards are protecting anything or quietly abstaining.

**This codebook is now a TYPE** — `Verdict` in `packages/tooling/ai-hook-rules/src/core/decision-log.ts`
— and it is what every layer writes to its log. It replaced `'ALLOW' | 'BLOCK'`, under which action 3
was a string SUFFIX (`… (fail-open)`) and actions 1 and 2 were indistinguishable. `'BLOCK'` was deleted
rather than aliased, so every construction site had to say which kind of block it meant.

Note what action 1 does NOT mean. A layer writing `ALLOW` is saying *it* had no objection and handed
the call down — never that the call ran. The three PreToolUse hooks execute in PARALLEL, so L-1 can
deny a call the guards binary allowed, and neither can see the other. **The true final action is the
join of `L-1-cd/` with `calls/`.**

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

## L-1 — the launch guarantee

Every layer above assumes the hook process ran at all. If it does not, the harness allows the call and
tells nobody. From the [hooks reference](https://code.claude.com/docs/en/hooks.md): exit `2` is the
blocking channel (stderr becomes the block reason), exit `0` carries the JSON decision, and **any other
exit is a "non-blocking error. Execution continues; the action proceeds"** — including
*"File missing or not executable: Error logged; tool proceeds."*

> **A hook that fails to launch is a silent ALLOW — not a block, not an error the AI sees.**

Nothing in this repo produces that state deliberately. A bad hook **path** produces it every time, and
that is what shapes the registration: `.claude/settings.json` carries **three** hooks, not two.

| hook | path | why |
|---|---|---|
| **L-1** `guarantee-root.sh` | **absolute** `$CLAUDE_PROJECT_DIR/…` | it must resolve from ANY cwd or it cannot fail closed. It refuses any `cd` that would park the shell where the other two cannot launch |
| guards `ai-hook.sh wp-ai-guards-hook` | **relative** | so each git tree runs its own shim, its own binary and its own pin — `$CLAUDE_PROJECT_DIR` never moves, so an absolute hook pins every worktree to the primary's release forever |
| rules `ai-hook.sh wp-ai-rules-hook` | **relative** | same |

The relative pair is admissible *only* because L-1 exists. All three, plus the two committed `.sh`
files and the `settings.json` `env` entry `CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR=1` (which pins the
Bash cwd to the project root, so those relative hooks always resolve — and, `env` being inherited, pins
it identically for every subagent), are compared against the installed release by fault `S`, and
`pnpm exec wp-upgrade-shim` regenerates all four.

The shim also runs the binary as a CHILD and maps any `rc` outside `{0,2}` onto fault K rather than
`exec`ing it — `exec` on a missing target exits 127 and therefore allows.

**L-1 is the one layer that can create no state needing recovery.** A denied `cd` never runs, so the
shell never leaves the root. It also reads no config, spawns no binary and touches no network — which
is why it is the only guard that cannot itself be broken by a bad config or a stale install.

### Decision rows — first match wins

Implemented in POSIX sh by `renderGuaranteeRoot()`
(`packages/tooling/ai-hook-rules/src/bin/guarantee-root.ts`), byte-locked against
`templates/guarantee-root.sh` by `guarantee-root.spec.ts`, which runs the REAL script through `/bin/sh`.

| # | condition | action | logged? |
|---|---|---|---|
| 1 | `tool_name` is not `Bash` | 1 `ALLOW` | no |
| 2 | command string unreadable/empty | 1 `ALLOW` | no |
| 3 | command does not OPEN with `cd`/`pushd` | 1 `ALLOW` | no |
| 4 | destination empty, or `-` (bare `cd`, `cd -`) | 4 `BLOCK_AI_CURE` — name the directory | yes |
| 5 | destination holds `$`, a backtick, or is `~`/`~/…` | 4 `BLOCK_AI_CURE` — spell the absolute path | yes |
| 6 | destination does not resolve | 1 `ALLOW-NO-SUCH-DIR` — the `cd` fails on its own | yes |
| 7 | resolved dir holds `.git` (dir **or** file — covers worktrees) | 1 `ALLOW-GIT-TREE` | yes |
| 8 | resolved dir is outside `$CLAUDE_PROJECT_DIR` | 2 `ALLOW-OUTSIDE` — harness resets cwd next call | yes |
| 9 | *default* — inside the governed tree, no `.git` | 4 `BLOCK_AI_CURE` — `git -C`, `pnpm -C`, `pnpm --filter`, `nx`, or `cd <root> &&` | yes |

Rows 1-3 are silent BY DESIGN — they are "not ours". The cost is stated rather than hidden: the audit
trail cannot distinguish *"no `cd` in this command"* from *"L-1 never ran"*.

### Audit log

```
$CLAUDE_PROJECT_DIR/.webpieces/logs/L-1-cd/<sessionId>-<agentId|coordinator>-guarantee-root.log

<ISO8601±offset>\t<VERDICT>\tfault=-\tdest=<resolved>\tcwd=<payload cwd>\t<command prefix>
```

`fault=-` is constant: L-1 detects no L0 fault. It is present so ONE grep spans every hook-written
stream rather than needing a per-layer field list.

**Always at `$CLAUDE_PROJECT_DIR`,** even when the call was made inside a linked worktree whose other
streams live under `worktrees/<name>/`. Resolving the worktree would cost a `git rev-parse` subprocess
on every Bash call, charged to the layer whose entire value is that it cannot fail — the wrong trade.
A reader (and the join described in the codebook section) simply knows where to look.

### Use cases

| scenario | row | action |
|---|---|---|
| `Edit` on any file | 1 | `ALLOW` |
| `pnpm run build-all` | 3 | `ALLOW` |
| bare `cd`, or `cd -` | 4 | `BLOCK_AI_CURE` |
| `cd ~/workspace/other && ls` | 5 | `BLOCK_AI_CURE` |
| `cd pakcages/http && ls` (typo) | 6 | `ALLOW` — the `cd` fails anyway |
| `cd ../wt-feature-x && git status` (linked worktree) | 7 | `ALLOW` |
| `cd /private/tmp/…/scratchpad && ls` | 8 | `ALLOW` |
| `cd packages/http/http-server && pnpm test` | 9 | `BLOCK_AI_CURE` → `pnpm --filter @webpieces/http-server test` |

### Known gaps — stated, not discovered later

1. **A double-quoted target always denies with the WRONG message.** The command capture stops at the
   JSON backslash, so `cd "…"` yields an empty destination and row 4 fires with "name the directory" —
   which the caller already did. The single-quoted spelling ALLOWs and is never mentioned.
2. **Unset `CLAUDE_PROJECT_DIR` fails closed filesystem-wide**, prescribing `cd  && <your command>`
   with an empty root, and writes no audit line.
3. **The token scan is leading-word only**, so `cd -- sub`, `CDPATH= cd sub` and `eval cd sub` are
   unjudged; `popd` is unjudged while `pushd` is judged.

These are why L-1's row array is still a TODO: converting it to `LMINUS1_ROWS` (generating both the
script and this table, the way `L1_ROWS` generates `guards/L1-location.md`) is the change that would
make the table above impossible to leave stale — and is the right moment to fix all three.

Full treatment: [decisions/0003](decisions/0003-three-hooks-per-tree-governance.md) §1 and §4,
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
