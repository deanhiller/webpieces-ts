# 0003 — Three hooks: per-tree governance without a bridge

**Status:** SHIPPED 2026-08-07 (see §4.9) — H1 exists and is wired, H2/H3 are relative, `BIN` walks up
with a version check, and the upgrade path repairs all three managed things. Q1 (F12) remains unmeasured.
**Raised:** 2026-08-06
**Resolves:** [0002](0002-the-shim-cannot-follow-the-tree.md) (the shim cannot follow the tree)
**Replaces:** 0002 Option A (the bridge/trampoline) — killed by adversarial review, see §6

---

## 1. The idea

`.claude/settings.json` today registers two hooks, **both absolute**:

```
sh "$CLAUDE_PROJECT_DIR/.claude/webpieces/ai-hook.sh" wp-ai-rules-hook    (Write|Edit|MultiEdit)
sh "$CLAUDE_PROJECT_DIR/.claude/webpieces/ai-hook.sh" wp-ai-guards-hook   (Write|Edit|MultiEdit|Bash|Read)
```

`$CLAUDE_PROJECT_DIR` never moves, so **every tree is governed by the primary's shim forever** — that is
0002's whole problem. Replace with three:

| hook | path | job | changes |
|---|---|---|---|
| **H1** | **absolute** `$CLAUDE_PROJECT_DIR/.claude/webpieces/guarantee-root.sh` | **a separate, tiny, checked-in file.** Validate any `cd` in the command; refuse one that would land the shell where H2/H3 cannot launch | **rarely** |
| **H2** | **relative** `.claude/webpieces/ai-hook.sh wp-ai-guards-hook` | the real guards, from THIS tree | often |
| **H3** | **relative** `.claude/webpieces/ai-hook.sh wp-ai-rules-hook` | the real rules, from THIS tree | often |

```json
{ "hooks": { "PreToolUse": [
  { "matcher": "Write|Edit|MultiEdit|Bash|Read",
    "hooks": [{ "type": "command",
      "command": "sh \"$CLAUDE_PROJECT_DIR/.claude/webpieces/guarantee-root.sh\"" }] },
  { "matcher": "Write|Edit|MultiEdit|Bash|Read",
    "hooks": [{ "type": "command",
      "command": "sh \".claude/webpieces/ai-hook.sh\" wp-ai-guards-hook" }] },
  { "matcher": "Write|Edit|MultiEdit",
    "hooks": [{ "type": "command",
      "command": "sh \".claude/webpieces/ai-hook.sh\" wp-ai-rules-hook" }] }
]}}
```

H2/H3 are today's two hooks with `$CLAUDE_PROJECT_DIR/` deleted. H1 is new and is a **second checked-in
file** (§1.2). It matches the **same tools as H2**, not `Bash` alone — `Bash` carries the `cd` that
maintains the invariant, but every tool needs the base-case cwd check, because H2/H3 are relative and a
`Write` from a bad cwd fails to launch them just as surely (§1.6).

### 1.1 H1 guards the TRANSITION, not the state

A session always starts at a tree root (primary for the coordinator, worktree for a subagent). The only
thing that moves it is a `cd`, and a `cd` **into** the workspace **persists** to later calls — measured
2026-08-02, `effective-tree.ts:25-28`. So:

> **If every `cd` that would leave a tree root is refused, "cwd is a tree root" is an INDUCTIVE
> INVARIANT.** H1 never has to inspect cwd — only the command.

That is why H1 can be tiny. It re-uses a policy this repo has already shipped and settled:
`effective-tree.ts` `misplacedCd()` — **a `cd` counts only as a literal path at the FRONT of the line**;
`cd <path> && <work>` is the one legal shape. H1 is that rule moved earlier, into `sh`, so it holds
before any binary runs.

**Four leaks the induction needs closed, all in the same check:** bare `cd` (goes to `$HOME`), `cd -`
(unknowable target), `pushd` (already in `effectiveCwd`'s leading run), and a non-literal target
(`$VAR`, `~`, `$(…)`) — which `misplacedCd()` already refuses with the fix spelled out.

### 1.2 Why `guarantee-root.sh` is a SEPARATE file

Splitting it out of `ai-hook.sh` is what makes the design honest:

- **It is the one file that must stay `$CLAUDE_PROJECT_DIR`-anchored**, so it is the one file that
  cannot be upgraded per-tree. Keeping it separate keeps that surface **minimal** — a path check, no
  drift scraper, no allowlist, no config, no binary.
- **Its stability profile is the opposite of `ai-hook.sh`'s.** The shim changes most releases; a `cd`
  validator should converge and then stop. Sharing a file forces the stable half to inherit the
  volatile half's churn — which is exactly today's problem, one level up.
- **Fault S extends for free**: the comparator already compares the committed shim against
  `renderShim()`; it gains a second, independent comparison for `renderGuaranteeRoot()`. Each file
  reports its own drift and prescribes its own re-install.

### 1.3 H1's predicate — "can H2/H3 launch there?", NOT "do we have jurisdiction?"

Conflating those two questions is what made an earlier draft complicated. They differ:

| `cd` destination | can H2/H3 launch? | do we WANT them to? | H1 |
|---|---|---|---|
| a tree root (primary or worktree) — has `.claude/webpieces/ai-hook.sh` | yes | yes | **ALLOW** |
| a foreign clone (own `.git`, no shim) | no | **no** — hands-off by design | **ALLOW** |
| outside any git repo (`/tmp`, scratchpads) | no | **no** | **ALLOW** |
| a subdirectory of a governed tree | no | **yes** | **BLOCK** — `cd <root> && …` |

So the check is: does the destination hold `.claude/webpieces/ai-hook.sh`? If not, walk up to the first
`.git`; if **that** root has no shim either, it is not ours — stand down.

### 1.4 The whole predicate: `.git` presence + the harness's own reset

`.git` presence is a **complete** test for "H2/H3 can launch, or it is not ours", because every
destination we must allow has one:

| destination | `.git` | why allowed |
|---|---|---|
| primary clone root | **dir** | H2/H3 launch |
| any linked worktree root (nested or sibling) | **file** | H2/H3 launch, per-tree ✅ |
| nested clone `repositories/<repo>` | **dir** | foreign — hands-off by design |

So there is **no `excludePaths` logic in H1 at all**. It cannot read config (it is `sh`, pre-config,
pre-binary) and it does not need to.

**The one deliberate divergence**, measured on consumer-monorepo2 (`excludePaths: ["repositories/**",
"tools/**"]`): `repositories/portal-v2` has its own `.git` → allowed, agreeing with `excludePaths`;
`tools/` does **not** → blocked, where `excludePaths` would exempt. That is *correct for H1's purpose* —
the real hooks genuinely cannot launch in `tools/`, and we genuinely want them to. `excludePaths`
governs which FILES are enforced, not whether the hook may run. Cost: **4 calls in 2,236**.

### 1.5 `cd` OUTSIDE the repo — already solved by the harness

The harness distinguishes the two cases for us (`effective-tree.ts:18-28`, measured 2026-08-02, and
observable live — a `cd` out prints `Shell cwd was reset to <root>`):

- a `cd` that stays **inside** the workspace **PERSISTS** to later calls;
- a `cd` that **LEAVES** it is **RESET** by the harness before the next call.

So the danger is not "unguarded", it is **"sticky AND unguarded"**, and that is exactly one region:

| destination | sticky? | H2/H3 next call | verdict |
|---|---|---|---|
| has `.git` | yes | launch at that root ✅ | **ALLOW** |
| outside `$CLAUDE_PROJECT_DIR` | **no — harness resets** | launch, back at root ✅ | **ALLOW** |
| inside the project, no `.git` (`tools/`, `dataform/`, `packages/…`) | **yes** | **never launch again** | **BLOCK** |

`cd /tmp/scratch && cat foo` costs at most **one** call executed at a path we do not govern — nothing to
guard there — and the shell is back at the root by the next call. **54 of the 2,236 measured calls
(2.4%) went outside any repo; all of them ALLOW.**

**"How to handle `cd` back?" — there is nothing to handle.** Two independent reasons:

1. A `cd` out is undone by the harness automatically.
2. A **blocked** `cd` never executes. `PreToolUse` denies the whole tool call *before* the shell moves,
   so the shell is still exactly where it was — at a root. **There is no bad state to recover from and
   no cure command to allowlist**, which deletes the review's required change 7 and its deadlock risk
   ("a block whose cure is itself blocked").

The predicate is three tests:

```sh
[ -e "$DEST/.git" ] && exit 0                                   # tree root, worktree, or foreign clone
case "$DEST/" in "$CLAUDE_PROJECT_DIR"/*) ;; *) exit 0 ;; esac   # outside -> harness resets it
deny "cd <root> && … : .claude/webpieces/ai-hook.sh does not exist in $DEST, so the guards cannot run there"
```

### 1.6 The base case — H1 must match every tool, not just Bash

§1.1's induction assumes the shell **starts** at a root. That holds for a new session, but not if the
shell was already parked somewhere bad (an older release, a session that predates H1, any drift). And
the state matters for **all** tools, not just Bash: H2/H3 are relative, so a `Write` issued while cwd is
`tools/` also fails to launch them.

So H1 matches the same set as H2 (`Write|Edit|MultiEdit|Bash|Read`) and runs the same predicate against
two inputs:

- **Bash** → validate the `cd` **destination** (maintain the invariant) **and** the payload `cwd` (base case)
- **everything else** → validate the payload `cwd` only

Same three tests, different argument. This is the one place H1 looks at `cwd` — and it is why the
`.claude/settings.json` in §1 uses the full matcher for H1 rather than `Bash` alone.

Because H2/H3 are relative, the harness resolves them **from the tool call's own cwd**, so each tree
runs its own committed shim. That shim's `$0` then yields `ROOT` == that tree, so **shim logic, binary
and pin all come from one tree** — INVARIANT-1VERSION (§2) satisfied, with no `cd` parsing anywhere in
our `sh`.

**The split is the point.** H1 is the one file that cannot be per-tree, so it is deliberately made the
*smallest and most stable* thing in the system. H2/H3 carry all the volatile logic and are free to
change per release, because each tree gets its own. That inverts today's situation, where the volatile
file is the one that can never be upgraded per-tree.

---

## 2. The invariant, corrected

0002 stated `INVARIANT-1TREE` as "shim, binary and package.json must come from one *tree*". That is
wrong and too strong. The real constraint is about **version agreement**:

> **INVARIANT-1VERSION — the shim's logic and the binary that runs must match the pin of the tree
> being judged.**

Where the shim and binary physically *sit* does not matter. A nested worktree with no `node_modules`
of its own, walking up to the primary's, is **completely fine** as long as its pin equals the primary's
installed version. Ideally the binary is in the same tree; it is not strictly required.

### 2.1 …but "not strictly required" has a sharp edge: state-dir clobbering

An older binary running against a newer tree (or vice versa) can write state to a **different layout**
than the tree's own release expects. Concretely: `<primary>/.webpieces/instruct-ai/` versus
`<primary>/.webpieces/worktrees/<tree>/instruct-ai/` — the `shared()` vs `local()` split
(`state-dir.ts:135-165`). Two releases that disagree about which scope a file belongs to will **clobber
each other**, and the layout has already moved once (the per-worktree → primary-namespace migration,
plus `hooks/` → `logs/`).

So a mismatched binary is not merely "reads the wrong version number" — it can **corrupt shared state**.
This is a second, independent reason to want the binary in the tree, and it argues for H2/H3 even where
INVARIANT-1VERSION alone would tolerate a walk-up.

---

## 3. Evidence — this is measured, not assumed

### 3.1 From our own logs: `$CLAUDE_PROJECT_DIR` never moves, the payload `cwd` does

`.webpieces/worktrees/*/logs/guard-invocations.log`, four independent trees including a purpose-built
probe from 2026-08-03:

```
root=<primary>/.claude/worktrees/projdir-probe             projectDir=<primary>
root=<primary>/.claude/worktrees/agent-ac1ce82d58c21eaac   projectDir=<primary>
root=<primary>/.claude/worktrees/agent-ae089e758aedb85a7   projectDir=<primary>
root=<primary>/.claude/worktrees/agent-af4ed94400054878b   projectDir=<primary>
```

`root` is resolved from the payload `cwd` and correctly tracks the worktree; `projectDir` is
`$CLAUDE_PROJECT_DIR` and is pinned to the primary on every line. **Only the hook PATH is wrong.**

Bonus from the same logs: `agent-af4ed94400054878b` ran
`rm -rf <nested-worktree>/node_modules && pnpm install` successfully on 2026-08-03 — partial evidence
for 0002 Q3 (a nested worktree *can* hold its own `node_modules`).

### 3.2 From the official docs (https://code.claude.com/docs/en/hooks.md)

| # | fact | why it matters |
|---|---|---|
| F7 | *"The hook runs in the `cwd` value from the JSON input"* | **the core premise.** Relative H2/H3 resolve against the worktree. Confirmed, not inferred |
| F8 | *"all matching hooks run in parallel"*; hooks **merge** across settings levels | H1+H2+H3 all fire; user hooks don't displace project hooks |
| F9 | exit `0` → stdout parsed for JSON; exit `2` → **blocking**, stderr fed to Claude; **any other non-zero → non-blocking, the action proceeds** | the failure mode below |
| F10 | *"File missing or not executable: Error logged; tool proceeds"* | **the single biggest hazard** — see §4 |
| F11 | shell form is `sh -c`; default timeout 600 s | arbitrary `sh` in the hook command is legal |
| F12 | **not documented:** what wins when parallel hooks disagree (one denies, another allows) | the only remaining unknown — §5 |

---

## 4. The hazard H1 exists to cover

F10 is the whole reason H1 must stay absolute:

> **A hook that FAILS TO LAUNCH is a silent ALLOW. Not a block, not an error the AI sees — an allow.**

The chain, every link documented (https://code.claude.com/docs/en/hooks.md):

```
relative path does not resolve
  → sh: .claude/webpieces/ai-hook.sh: No such file or directory
  → exit 127                        (not 0, not 2)
  → "Non-blocking error. Execution continues; the action proceeds."
  → "File missing or not executable: Error logged; tool proceeds."
  → the tool call runs WITH NO GUARDS, and nothing is surfaced to the AI or the user
```

We never exit non-zero-without-JSON *deliberately* — exit `2` is our block channel and exit `0` carries
the JSON decision. This state is reached only when the hook **command itself cannot start**, which is
exactly what a relative path does when cwd is wrong.

Every way to reach it:

| trigger | why the path does not resolve |
|---|---|
| cwd is a subdirectory of a tree | `.claude/…` is relative to cwd, not to the tree root |
| cwd is outside every repo (`/tmp`, a scratchpad) | no `.claude/` there at all |
| a fresh worktree before `pnpm install` | the file is committed, so this one usually *is* fine — but a checkout predating the installer is not |
| a branch/commit predating `wp-install-ai-hooks` | no `.claude/webpieces/ai-hook.sh` in that tree |
| the file exists but is not executable / `sh` is missing | same 127-class outcome |

**So relative hooks ALONE are strictly worse than today**: today a wrong cwd gets the *wrong tree's*
guards, which is a correctness bug; with relative-only it gets *no* guards, which is a security hole,
and it is invisible. H1 is not belt-and-braces — it is what makes H2/H3 admissible at all.

H1 closes it: absolute, therefore always resolvable, therefore always able to fail closed. Its message
must also say plainly that **`$CLAUDE_PROJECT_DIR` cannot be used to fix anything inside a worktree** —
it points at the primary's shim, i.e. the wrong version — because that is precisely the misdirection
that burned five no-op installs in the `coordinator-worktree.ts:40-47` incident.

### 4.1 Rejected: a "walk up to the nearest tree" hook command

`sh -c 'd=$PWD; while [ ! -f "$d/.claude/…" ]; do d=$(dirname "$d"); done; sh "$d/…"'` would make
subdirectories work with no force-root rule at all. **Rejected deliberately.**

Silently relocating which tree governs is worse than a loud block: the AI then cannot explain why
`cd /path && ls` behaved as it did, and it learns nothing. The repo already made exactly this call for
`cd` itself — `effective-tree.ts` `misplacedCd()`: *"Rejecting is the simpler contract … ONE legal
shape, everything else refused with the fix spelled out … trades a silent misdirect for a loud one-line
rule."* Blocking with a clear message to the AI is the intended behaviour, and it is consistent with
precedent.

### 4.2 MEASURED: how much does the AI actually `cd`?

Measured 2026-08-06 over **2,234 real Bash calls** from `guard-invocations.log` across three repos.
This replaces an earlier estimate that surveyed only this repo's `package.json` scripts and concluded
"no script requires a subdirectory cwd" — true here, and **wrong for the consumer repo**.

| repo | Bash calls | leading `cd …` | |
|---|---|---|---|
| `acme/consumer-monorepo2` | 953 | **296 (31.1%)** | the real client monorepo |
| `personal/webpieces-ts30` | 990 | 153 (15.5%) | mostly `cd <worktree-root>` — already fine |
| `acme-edu/consumer-repo2` | 291 | 34 (11.7%) | mostly `cd <tree-root>` — already fine |

Of consumer-monorepo2's **128** `cd`s landing under the tree root:

| | count | H1's correct verdict |
|---|---|---|
| `repositories/**` — a **foreign nested clone**, already hands-off via `excludePaths` | **70 (55%)** | **must ALLOW** — top target `repositories/portal-v2` alone is 49 |
| `.claude/worktrees/agent-*` — **a tree root** | 34 (27%) | ALLOW — this is the design working |
| genuine subdirs (`dataform`, `terraform/observability`, `repositories/portal-v2/src`, `…/tools/validate-bq-rejections`) | **24 (19%)** | BLOCK |

**So the true handicap is 24/953 = ~2.5% of Bash calls** — one loud block and one `cd` to recover.
Acceptable.

**But the naive predicate would wrongly block another 70 (7.3%)**, and that is the dominant real case,
not an edge case. Required change 10 was ranked last by the review; the data says it is **first**.

### 4.3 The predicate the data implies — a `.git`-boundary walk-up, no config load

Required change 5 proposed exactly `[ -f "$cwd/.claude/webpieces/ai-hook.sh" ]`. That blocks all 70
foreign-repo calls, because H1 runs in `sh` and cannot load `excludePaths`. It does not have to:

```
walk up from cwd to the FIRST directory containing .git   (that is the enclosing repo/worktree root)
  ├─ no .git found anywhere            → ALLOW   (outside every repo — /tmp, scratchpads)
  ├─ that root has NO .claude/webpieces/ai-hook.sh → ALLOW   (foreign clone — not our jurisdiction)
  ├─ that root IS cwd                  → ALLOW   (H2/H3 will resolve here)
  └─ that root is an ANCESTOR of cwd   → BLOCK   ("cd <that root> && …")
```

The `.git` boundary is what exempts foreign repos **without** a config load: a nested clone has its own
`.git`, so the walk stops there, finds no shim, and stands down. Verified against every measured case:

| measured target | walk stops at | verdict |
|---|---|---|
| `repositories/portal-v2` (49) | its own `.git` | ALLOW ✅ |
| `.claude/worktrees/agent-X` (21) | its `.git` **file** (worktree) — is cwd | ALLOW ✅ |
| `.claude/worktrees/agent-X/tools/validate-bq-rejections` (4) | worktree root | BLOCK ✅ correct |
| `dataform` (4), `terraform/observability` (3) | monorepo root | BLOCK ✅ correct |
| `/tmp/...` scratchpads (22) | no `.git` | ALLOW ✅ |

Crucially this is also *sound* w.r.t. §4's hazard: **the F10 silent-allow only matters for trees we
govern.** For a foreign clone or `/tmp`, "no guards" is already the correct and intended answer, so
allowing there gives up nothing.

### 4.4 Is force-root a real handicap?

Probably not, because **it is already the rule**:

- `runner.ts:256` already ships a `force-to-root` block (git/gh from a subdirectory).
- The house rule is already recorded: *"never `cd` into a sub-package in Bash; it persists and blocks
  the global hook."*
- `effective-tree.ts:25-28` measured that a `cd` **inside** the workspace **persists** to later calls,
  while one that leaves it is reset by the harness — which is what makes a stray subdirectory cwd a
  lasting problem rather than a momentary one.

Residual cost: `cd packages/tooling && pnpm test` leaves the shell in a subdirectory, so the *next*
call needs a `cd <root> &&` first. Mitigations that already exist: `git -C`, `pnpm -C`, `pnpm --filter`,
`nx` from the root. H1's block message should name these.

---

## 4.5 SHIPPED (2026-08-06) — H1 exists, source only

`packages/tooling/ai-hook-rules/src/bin/guarantee-root.ts` + `templates/guarantee-root.sh`, byte-locked
to each other by `guarantee-root.spec.ts` exactly as `renderShim()`/`templates/ai-hook.sh` are. 28 tests,
all green; `pnpm run build-all` green.

**`.claude/settings.json` is deliberately NOT flipped** — per §6 the registration change must wait until
a release that ships this file is installed, and until H-1 (`BIN` does not walk up) is fixed. Shipping
the file first is what makes the later flip a no-op for anyone already upgraded.

The spec runs the real `sh` against real PreToolUse payloads in a real tree — a TypeScript-string
assertion would prove nothing about `sed`, `case` or `cd`.

### 4.6 Bug found while testing: a double quote silently disabled the guard

Writing the spec caught a hole that a code review would not have:

```
payload:  {"command": "cd /a/b && echo \"hi\""}
sed  's/.*"command"[^"]*"\([^"\\]*\)".*/\1/p'   ->   ''     (EMPTY)
```

A JSON payload escapes an embedded quote as `\"`, and `[^"\\]*` stops dead at that backslash, so the
conventional "capture between quotes" form returns the **empty string for the entire command**. In H1
an empty command reads as "no `cd` here" → **ALLOW**, so `cd <subdir> && echo "hi"` was completely
unguarded — the exact hazard the file exists to close, reachable by adding one quote.

**Fix:** capture only the *prefix* (no closing `"` in the pattern). Everything L-1 needs — the first
word and the `cd` target — lives before any quote can appear. Locked by three regression tests.

**FIXED in `ai-hook.sh` too — but with a SECOND variable, because the split is a security boundary.**
Measured first: **3,908 of 4,917 shim audit lines (79.5%) recorded an empty command** — four out of five
audit entries were blind.

The obvious fix (prefix-capture) applied to `$CMD` would be a **hole**, because `$CMD` is also what the
L0 allowlist greps, and every allowlist ERE is anchored `^…[[:space:]]*$` with trailing whitespace
tolerated. So `pnpm install "; rm -rf /"` prefix-captures to `pnpm install ` — which **matches** — and
the injection after the quote rides through allowlisted. Today's empty-string behaviour is the *safe*
direction there: no match, falls to the deny, **fail closed**.

So `$CMD` (decision) keeps the strict pattern and `$CMD_LOG` (audit only) gets the prefix. Verified:

| command | `$CMD` (decides) | `$CMD_LOG` (audits) |
|---|---|---|
| `pnpm install` | `pnpm install` | `pnpm install` |
| `cd /a/b && echo "hi"` | *(empty — fail closed)* | `cd /a/b && echo ` |
| `pnpm install "; rm -rf /"` | *(empty — **injection cannot ride through**)* | `pnpm install ` |

### 4.7 SHIPPED: per-session / per-agent / per-hook log streams

`core/log-stream.ts` (+ spec). Log paths were keyed by git worktree alone, so **three** different things
shared one file: the two hooks Claude Code runs **in parallel** on every file edit, subagents sharing a
tree, and whole sessions (four coordinators all have **no** `agent_id`). Measured: 6.3% of
`guard-invocations.log` lines and 5.1% of `guard-sync-decisions.log` exceed macOS's 512-byte `PIPE_BUF`,
so this **tears today**.

```
<local>/logs/<sessionId>-<agentId | "coordinator">-<hook>-<file>.log
```

One writer per FILE, by construction. `session_id` is now parsed off the payload (it was not read at
all before) and `hook` is the existing `HookMode`.

**Deliberately FLAT, not `sessions/<id>/<agent>/<hook>/<file>`.** A nested tree turns the common
question — *"show me everything that happened, in time order"* — into a directory walk, when it should
be one glob:

| question | glob |
|---|---|
| everything | `ls logs/` |
| one window | `logs/<sid>-*` |
| one subagent | `logs/*-<agent>-*` |
| one hook across all agents | `logs/*-guards-*` |

Rotation is untouched, because `.1.log` is still a suffix and the WHOLE filename goes through
`fileName()` — so the sibling gets the identical prefix.

`transcript_path` is also unique per session, but it is a filesystem **path** — long and full of
separators that would have to be flattened anyway — and `session_id` is its stable identifier, so
`session_id` is the better key.

Unidentified callers — the openclaw adapter, the detached refresher, every existing spec — get the
historical bare filename unchanged, so no writer can be stranded. Payload ids are treated as untrusted
path input (separators and dot-runs collapse; capped; never empty), covered by traversal tests.

H1 gets its own `cd-audit.log` under the same scheme — it is a **third** parallel writer on every Bash
call — and needs no worktree resolution, since it is `$CLAUDE_PROJECT_DIR`-anchored by definition.

### 4.8 Two things a future reader will get wrong

**(a) `$CMD` / `$CMD_LOG` is a SECURITY boundary, not duplication — do not "simplify" it.**
It reads like the same extraction written twice. It is not. `$CMD` is a DECISION input (the L0
allowlist greps it) and `$CMD_LOG` is an AUDIT input. Every allowlist ERE is anchored
`^…[[:space:]]*$` and tolerates trailing whitespace, so giving `$CMD` the audit pattern makes
`pnpm install "; rm -rf /"` capture as `pnpm install ` — which **matches** — and the injection after the
quote rides through allowlisted. The empty string is the *correct* value for a decision input: it
matches nothing and falls to the deny. **Collapsing these two variables re-opens a hole.** The reasoning
is written at the definition site in `shim.ts`; keep it there.

**(b) This collides with PR #579, and #579 is the one that should give way.**
Both change `core/decision-log.ts`, `core/rejection-log.ts` and `adapters/hook-core.ts`. #579 keys logs
on `agent_id` **only**, which still leaves the four-coordinator collision: `agent_id` is absent for the
coordinator, so four Claude Code windows are four writers all landing in the same `coordinator` stream.
`session_id` is what separates them (§3.1), and it is not read anywhere in #579. Take this change's
keying and rebase #579's other two halves (the generated L1 doc, the L0 fault stamps) on top — they are
independent of the log layout and are worth keeping.

## 4.9 SHIPPED (2026-08-07) — the flip, with H-1 and the upgrade path closed

Everything §4.5 deliberately left un-wired is now wired, in one change:

| # | what | where |
|---|---|---|
| 1 | **`BIN` walks UP** from `ROOT`, as Node's resolver does, and `BIN_ROOT` records which tree supplied it. Paired with the version check — DECLARED from `$ROOT/package.json`, INSTALLED from `$BIN_ROOT/node_modules` — so an inherited binary at a different version is **fault D** with the cure `cd <tree> && pnpm install`, never a silent straddle. Equal versions stay free, which is the common case | `shim.ts` `RESOLVE_BIN_SH` + `VERSION_DRIFT_GUARD_SH` |
| 2 | **H2/H3 are RELATIVE** — `sh ".claude/webpieces/ai-hook.sh" <bin>` | `hook-registration.ts` `shimCommand()` |
| 3 | **H1 is installed and registered** absolute, matcher `Bash` (the shipped `guarantee-root.sh` exits 0 immediately for every other tool, so a wider matcher would spawn a process per Write/Read to do nothing) | `setup.ts` `applyGuaranteeRoot()` |
| 4 | **The installed surface is THREE things**, and drift, the deny text and the cure all cover all three | `hook-registration.ts` `managedSurfaceDrift()`, `shim.ts` `shimStaleDenyReason()`, `upgrade-shim.ts` |
| 5 | 21 tests, driving the real `sh` against real payloads in real trees | `three-hook-registration.spec.ts` |

**Required changes 2, 3, 8 and 9 are done; 5 and 6 were already satisfied by the shipped file; 7 needs
nothing (a denied `cd` never executes, so there is no state to recover and no cure to allowlist).**

The near-miss worth recording: **`wp-upgrade-shim` wrote exactly one file**, and the `cp` cure on the L0
allowlist has the identical shape. Had the flip shipped without extending them, an upgrading consumer
would have taken the new shim, KEPT the old absolute two-hook registration, never received
`guarantee-root.sh`, and L-1 would have stayed dark — with nothing reporting it, because nothing
validated `settings.json` (Q4). A cure that repairs one of three is worse than no cure: it reports
success. `wp-upgrade-shim` now regenerates all three and says which; the `cp` fallback's deny text now
states out loud that it is PARTIAL.

Q4 and Q5 are answered. Q3 is answered by construction — the registration is a drift surface now, so a
branch that merges an old two-hook settings over a new one raises fault S rather than silently winning.

**Q1 (F12) is NOT settled experimentally.** The three hooks do not disagree in practice — H1 denies only
`cd`s, H2/H3 never emit an explicit allow (`claude-code-response.ts`; the allow path prints nothing), so
the "deny vs silence" race needs a deny and a *silence*, which is the shape the docs already describe as
"any hook may deny". If a live measurement ever shows silence beating deny, H1 must become the only
hook and this section is where to start reading.

## 5. Adversarial review verdict — **viable with changes**

Reviewed 2026-08-06 by a 26-agent adversarial pass (5 lenses, every finding refuted before counting).

The premise holds: F7 + F2 prove a relative hook resolves against the worktree, so each tree runs its
own shim, `$0` yields the right `ROOT`, and INVARIANT-1VERSION becomes achievable per tree — which
today's absolute registration makes structurally impossible.

**But the design as specified ships two major defects, and both trace to one line.**

### 5.1 H-1 (major) — `BIN` does not walk up, but Node does

```sh
ai-hook.sh:16    BIN="$ROOT/node_modules/.bin/$BIN_NAME"     # literal path
ai-hook.sh:151   if [ -x "$BIN" ] && [ -z "$DRIFT_PKG" ]; then
```

*(verified directly, not just reported)*

A **literal** path test with no upward walk — while Node's resolver **does** walk up (§0001 §2.2).
Today `ROOT` is always the primary, so the bin is always found. **The moment `ROOT` becomes the
worktree, every nested worktree without its own `node_modules` flips from "guarded for free" to
"fault X hard-blocks everything on the first tool call."** That is every worktree the Agent tool and
`/full-cycle` create.

The obvious patch — make `BIN` walk up — **directly violates INVARIANT-1VERSION** by pairing a worktree
shim with a primary binary at a possibly different version. It is admissible *only* with a version
check (see required change 2).

### 5.2 H-2 (major) — the flip breaks every live worktree on the same day

Same mechanism as a rollout event. Fault X is decided in `sh` **before** the binary runs, so per
`l0-matrix.ts:306-308` **Reads are unguarded** for the whole window between the settings flip and
someone running `pnpm install` in each tree. Reproduced live: the same nested tree returns exit 0 under
absolute invocation but `deny … (wp-ai-guards-hook not found)` under the relative form.

Good news: the existing `WORKTREE_NOTE` already fires when `$ROOT/.git` is a file, so the *message* is
already right. Only the timing and cost are wrong — which is a sequencing problem, not a design one.

### 5.3 H-3 (minor) — H1's `sh`-side fault preempts the JS-side faults

Faults S/C/Y are `enforcedIn: 'JS'` (`l0-matrix.ts:171-199`) and only reachable past the `[ -x "$BIN" ]`
gate. On an H1 path running an old shim that gate never opens, so **S is unreachable on H1 forever**.
If deny wins, H1's fault-X text ("run `pnpm install`") is what the agent reads while H2/H3 are raising S
with the correct `wp-upgrade-shim` cure — the wrong cure, which per `shim.ts:479-502` is how an agent
gives up after ~4 attempts.

### 5.4 Required changes

1. **Settle F12 first** (§5.5) before writing any implementation.
2. **Resolve the `node_modules` gap explicitly** — either (a) keep `BIN` `$ROOT`-local and make worktree
   creation run `pnpm install`, or (b) let `BIN` walk up like Node **and** have the binary refuse to
   decide when `installedShimRulesVersion()` disagrees with the pin of the tree it is judging. **(b)
   without that check rebuilds the four-cure straddle from scratch.**
3. **Ship change 2 one full release BEFORE the settings flip** — the repo runs the previous release, so
   a same-release flip breaks every open worktree with no installed cure.
4. **Give H1 its own fault code; forbid it from emitting D/X/U/K** (fixes H-3).
5. **H1's predicate is exactly `[ -f "$cwd/.claude/webpieces/ai-hook.sh" ]` and nothing more** — literally
   the condition the harness uses to resolve H2/H3, so it can neither over- nor under-approximate F10.
   No binary, no git, no config load: H1 stays green precisely when everything else is broken.
6. **Keep `Read` unconditionally allowed under H1** (matching `ai-hook.sh:197-200`). An unresolvable
   H2/H3 makes *Bash* dangerous, not Read — and Read is how a blocked agent diagnoses the block.
7. **Allowlist the cure**: bare `cd <tree-root>` and `cd <tree-root> && pnpm install`. The trained shape
   `cd <literal> && <work>` does **not** move the harness's resolution for the *next* call. **A block
   whose cure is itself blocked is a deadlock, not a handicap.**
8. **Add a settings.json drift signal analogous to fault S** — nothing validates the hook registration
   today, so a stale two-hook settings silently disables H1, the one component whose whole job is
   failing closed.
9. **Document force-root as TWO rows in `guards/L1-location.md`**, not one: H1 judges the *shell* cwd for
   *all* tools against "is a tree root"; `gitFromSubdirBlock` (`runner.ts:245-259`) judges the post-`cd`
   `effectiveCwd` for *git/gh only* against "is THE root". Collapsing them is how the `shellAtRoot` bug
   happened the first time.
10. **Exempt foreign repos and `excludePaths` from H1** — it runs in `sh` with no config load, so
    `repositories/**` and the `/tmp` scratchpad (deliberately hands-off today) would become blocking
    territory.

### 5.5 The experiment — F12 only

F7, F9, F10, F11 are settled by documentation. **Do not re-test them.** One question decides the shape:

> **When parallel PreToolUse hooks disagree, does `deny` win over silence?**

Not "deny vs allow" — **deny vs silence**, because the real guards only ever emit `deny` and never an
explicit allow (`claude-code-response.ts:41-42`; the allow path prints nothing). That is the shape this
design actually produces.

**Safety property:** no settings file in the repo is ever edited. Each case is a nested non-interactive
`claude -p` that loads probe hooks via `--settings` and *deselects* the project source with
`--setting-sources local`, so the real guards never load into the probe session. The probe emits a
decision only for the payload carrying a nonce; every other call logs and exits 0 (= "no decision →
normal permission flow"), so it can neither block real work nor grant a bypassing allow. `rm $SP/ARMED`
makes every probe an instant no-op. Throwaway worktrees live under `.claude/worktrees/`, which
`.git/info/exclude:11` hides from `git status`.

| # | setup | reading |
|---|---|---|
| 0 | positive control, log-only | no line ⇒ tooling/flag problem, **STOP**. `--print` silently ignores settings that fail validation, so a JSON typo is indistinguishable from "hooks don't run" |
| 2e | negative control | if blocked, something else is denying and every 2x reading is void |
| **2a** | **deny + silence** | **THE answer.** Blocked ⇒ deny beats silence ⇒ H1 can fail closed ⇒ premise holds. Not blocked ⇒ **three-hook is dead as specified**; H1 must become the only hook |
| 2d | deny + a 127 entry | the design's worst day (H1 fine, H2 unresolvable). Blocked ⇒ fail-closed survives a broken H2 |
| 2b/2c | deny + explicit allow, both array orders | order-dependence ⇒ safety depends on array order in a file `setup.ts:452-455` writes with `push()` |
| 1a | relative hook, cwd=worktree | `pwd=` + `$0=` on one row with `CPD=` is the direct F7-vs-F2 measurement |
| 1b | relative hook, cwd where the file is absent | confirms F10 live; capture the `--debug hooks` line — it is the **only** operator-visible trace |
| 1c | two byte-identical commands | 1 line ⇒ dedupe by command string; then check whether an absolute and a relative form resolving to the *same file* also collapse — if so **H1 and H2 silently merge in the primary** and H1's job disappears |
| 3 | session rooted in a worktree with its own settings | proves a worktree's own settings.json is honoured |

Run order **0 → 2e → 2a → 2d → 2b/2c → 1a → 1b → 1c → 3**; if 2a shows deny losing, cases 1 and 3 are
moot. Keep `--debug hooks` output per case as an independent second channel — disagreement with the
probe log is itself a finding.

**Not a harness question:** "does H1 correctly block a subdirectory cwd" is pure logic in our code and
belongs in `ai-hook-rules`'s vitest suite, which per CLAUDE.md resolves `@webpieces/*` to local src.

Revert: `rm $SP/ARMED`, `worktree remove --force` both probes, `worktree prune`, delete the probe
branches, then assert `git diff -- .claude/settings.json` is **empty** and `settings.local.json`'s
`shasum` is unchanged.

---

## 6. Why not the bridge (0002 Option A)

Killed by adversarial review (35 agents, every finding refuted before counting). Three confirmed kills:

1. **Every pre-bridge release misfires.** Released stage 2 does `ROOT=$(dirname $0)/../..`; exec'd from
   inside `node_modules` that makes `ROOT` the *package's own directory*, so it finds no
   self-declaration and emits **fault U with an uncurable cure**. "One release behind" is the steady
   state, so this is the normal path for a full release cycle.
2. **`exec` inverts fail-closed.** `exec` on a missing file exits 127 → per F9/F10 the call proceeds
   **unguarded**. The current shim deliberately captures rc and maps anything outside `{0,2}` to fault K
   (`ai-hook.sh:94-95, 151-177`).
3. **It hands the agent a downgrade lever.** Stage 1 would choose which release's guards apply by
   re-parsing a `cd` in POSIX `sh` — so `cd <old worktree> && <work>` runs whatever `@webpieces` that
   tree holds, including a release predating the guard meant to stop that work, with nothing reporting
   the downgrade.

The three-hook design avoids all three: no `exec`, no `sh`-side `cd` parsing, and the harness (not our
code) picks the tree from the real cwd.

**Note the residual risk that per-tree governance cannot avoid by construction:** an agent that moves to
an older tree gets that tree's older guards. That is inherent to the goal, not to this design. A
**version floor** in H1 — never govern below the primary's release — is the candidate mitigation.

---

## 7. Open questions

| # | question | blocks |
|---|---|---|
| Q1 | F12: does `deny` win among parallel hooks? | the whole design |
| Q2 | Should H1 enforce a version floor (never govern below the primary's release)? | §6 residual risk |
| Q3 | How do we adopt this given the one-release lag — `.claude/settings.json` is checked in and written by `setup.ts`, and a branch can merge an old 2-hook settings over a new 3-hook one | rollout |
| Q4 | Is there any drift check on `.claude/settings.json` the way fault S guards the shim? If not, a stale settings silently reverts to 2-hook behaviour | rollout |
| Q5 | Does fault S become per-tree automatically under H2/H3? (It should: each tree's shim is compared against that tree's installed release by `governingShimRoot()`) | correctness |
| Q6 | `ai-hook.sh` logs an EMPTY command for any command containing a double quote (§4.6). Fix the audit log's `CMD` extraction the same way H1's was fixed? | observability only |
