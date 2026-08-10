# FINAL PLAN — One Governor, Two Hooks, One Version

**Branch context:** `dean/close-unknown-rule-backlog`, repo `/Users/deanhiller/workspace/personal/webpieces-ts50`.
**Live pin today:** `pnpm-workspace.yaml` → `'@webpieces/nx-webpieces-rules': 0.4.616`; installed `@webpieces/ai-hook-rules` and `@webpieces/nx-webpieces-rules` both `0.4.616`. Call that release **N**.

---

## 1. WHAT CHANGES, IN ONE PARAGRAPH

Both webpieces guard hooks move from a **relative** registration (`sh ".claude/webpieces/ai-hook.sh" <bin>`) to an **absolute** one (`sh "$CLAUDE_PROJECT_DIR/.claude/webpieces/ai-hook.sh" <bin>`), which makes the main tree the single governor of every tree. Because an absolute path always resolves, the L-1 hook `guarantee-root.sh` — whose only job was to guarantee the relative path resolved, and which paid for that by denying every `cd` into a project subdirectory — is deleted outright, along with its renderer, its spec, its template, its `L-1-cd` log stream, and the "a `guards=ALLOW` line is not the outcome, you must JOIN with `L-1-cd/`" caveat that existed only because a third parallel hook could veto what the guards binary allowed. `CoordinatorWorktreeGuard` and L1 row 3 are deleted too: with one governor the filesystem/governance split they policed is unconstructible, and agent identity was measured to be untrustworthy anyway (a reaped-then-resumed worktree agent silently falls back to the primary's cwd). In its place, the freed L1 dimension carries a new **row 8, `trinary-version-skew`**: when a Write/Edit or non-inspection Bash call targets a *linked worktree of this main tree*, and that worktree's `@webpieces/nx-webpieces-rules` catalog pin differs from the main tree's, the call is blocked with a message naming all three versions (worktree pin, main pin, the running binary) and the exact two-step fix. Nothing enforces per-tree governance any more, because per-tree governance was already fiction — measured: a worktree has no `node_modules`, so `ai-hook.sh` walks up and executes the **primary's** binary.

---

## 2. WHY THIS IS SIMPLER

**Deleted outright — 6 files, ~1,150 lines of code and spec:**

| File | Lines |
|---|---|
| `packages/tooling/ai-hook-rules/src/bin/guarantee-root.ts` | 364 |
| `packages/tooling/ai-hook-rules/src/bin/guarantee-root.spec.ts` | 331 |
| `packages/tooling/ai-hook-rules/templates/guarantee-root.sh` | 136 |
| `packages/tooling/ai-hook-rules/src/core/coordinator-worktree.ts` | 133 |
| `packages/tooling/ai-hook-rules/src/core/coordinator-worktree.spec.ts` | 235 |
| `.claude/webpieces/guarantee-root.sh` (post-release) | 113 |

**Plus, deleted from surviving files:**

- **12 exported symbols:** `GUARANTEE_ROOT_MARKER`, `guaranteeRootPath`, `writeGuaranteeRoot`, `renderGuaranteeRoot`, `committedGuaranteeRootStale`, `GUARANTEE_ROOT_MATCHER`, `GUARANTEE_ROOT_COMMAND`, `GUARANTEE_ROOT_ENTRY`, `GUARANTEE_ROOT_SURFACE`, `guaranteeRootRegisteredButMissing`, `AgentIdentity`, `UNKNOWN_AGENT`.
- **A whole guard layer.** The layer stack goes L-1/L0/L1 → **L0/L1**.
- **A managed surface.** `managedSurfaceDrift()` goes from THREE surfaces to TWO. Fault S's message loses a third of its body.
- **A log stream.** `LMINUS1_CD_STREAM` and its 4 references; `calls/` becomes authoritative for Bash again — no manual JOIN, and the documented log-placement anomaly (L-1 logs anchored at `$CLAUDE_PROJECT_DIR` while every other stream follows the worktree) disappears.
- **An L1 dimension's worth of rows:** row 3 plus use cases 12–16, the `L1Agent` type, `L1Classification.coordinator`, the `L1Row.a` field, and the entire `renderTwoLayerForceToRoot()` doc section (~34 lines of generated prose).
- **An `AgentIdentity` parameter** threaded through 4 functions in `runner.ts` and constructed in `hook-core.ts`.
- **Three known defects retired for free**, all recorded in `GUARD_MATRIX.md:198-203`: a double-quoted `cd` target denying with the wrong message; unset `CLAUDE_PROJECT_DIR` failing closed filesystem-wide with an empty-root cure; and the leading-word-only token scan missing `cd -- sub`, `CDPATH= cd`, `eval cd`, `popd`.
- **~95 lines of hand-written prose** (`GUARD_MATRIX.md`'s "## L-1 — the launch guarantee" section) and scattered L-1 paragraphs in 6 more docs.
- **Three open backlog bugs closed** by construction, not by patching.

**Net added:** one L1 row, one small version-reader class, one carve-out in `runInternal`, one deny message.

**The one honest cost:** *a catalog bump becomes a fan-out edit.* The moment the main tree's pin moves, every live worktree blocks until its own tracked `pnpm-workspace.yaml` is edited to match — and that edit dirties each feature branch with an unrelated catalog change. The catalog moved 8 times in the last ~3 weeks. This is real friction and it is the deliberate trade: the alternative is a worktree silently linted, validated and built by a release it never asked for, which is the bug being removed. See Open Decision #1 for how to soften it.

---

## 3. THE TRINARY GUARD

**Winner: `TrinaryVersionSyncGuard` — L1 row 8, block id `trinary-version-skew`, on the `V` dimension.**

Two of three judges picked it. The third preferred a pure-sh L0 fault plus a `git worktree add` creation gate. **Reasons for the pick:**

1. Its escapes are *structural*, not regex-shaped. The "do the work in the main tree" cure needs **no allowlist entry at all** — a main-tree-targeted call cannot match `K=w`, so no future allowlist tightening can break it.
2. It is the only design that audited its own prescribed commands against the real allowlist source and caught the landmine: `INSTALLER_BODY_ERE` is `(pnpm|npm)[[:space:]]+(install|i)` with a `--flag`-only tail, so **`pnpm -C <dir> install` fails closed at L0** while the tree is blocked at L1. It prescribes `cd '<main>' && pnpm install`, which passes.
3. It touches **no managed surface** — no `renderShim()` bytes, no `settings.json`, no templates — so `managedSurfaceDrift()` stays empty and no consumer takes a fault-S storm from it.
4. The rejected pure-sh design rests on a false premise: it claims `$ROOT` is always the main tree, but `ROOT` is `$CLAUDE_PROJECT_DIR`, which **is the worktree** in a worktree-rooted session — so it silently no-ops exactly where it is needed. It also puts a second hand-escaped awk YAML parser inside a byte-locked shim, the same construct that already shipped the catalog-blind `0.3.369 vs 0.4.405` incident.

The rejected design's best ideas are **grafted** (below). Its `git worktree add` creation gate and its `git worktree remove` allowlist widening are **not** adopted: the gate fails open on any parse difficulty and duplicates the backstop, and `git worktree remove` mutates, which the documented "git worktree TRAP" decision admits only `list` for.

### Where it lives

`packages/tooling/ai-hook-rules/src/core/l1-rows.ts` — new row 8 in `L1_ROWS`. Dispatched from `runner.ts`'s `l1LocationBlock` (Bash) **and** from `runInternal` (Write/Edit — this is what closes the measured "absolute-path Write into another worktree is judged against the wrong tree" hole). New file `packages/tooling/ai-hook-rules/src/core/pinned-webpieces-version.ts` holding `PinnedWebpiecesVersion` with one method and a per-root process cache.

`L1Classification`'s dying `coordinator: boolean` is **replaced** by `versionsInSync: boolean`. Dimensions stay `K/V/R/G/P` — arity unchanged at 5, so `l1-matrix.spec.ts`'s cross-product, its contiguity assertion and `renderL1Doc`'s legend keep their shape. Row numbers are stable identity: row 3 stays **retired**, never reused.

### Row 8 matcher

`K=w` (target resolves to a linked worktree) · `V=n` (pins disagree) · `R=n` (not a read-only inspection) · `G=-` · `P=-` · act **block** · cure runnable.

### What it compares

| Leg | Value | Source | Role |
|---|---|---|---|
| 1 | worktree pin | `<worktree>/pnpm-workspace.yaml` catalog `'@webpieces/nx-webpieces-rules'` | **ENFORCED** |
| 2 | main pin | `<mainRoot>/pnpm-workspace.yaml`, same key | reported |
| 3 | running binary | the version of the module that is **actually executing**, resolved from `__dirname` via `governingShimRoot()`, reading `@webpieces/nx-webpieces-rules`' manifest at that bin root | reported |

**Row 8 enforces leg 1 only.** Legs 2-vs-3 are already enforced by the shim's fault D on every call, before the binary even runs — under absolute registration `ROOT == BIN_ROOT == main`. A second comparison here would be two spellings of one check, which CLAUDE.md rejects. This is stated in a code comment so nobody grows a 2-vs-3 cure in row 8 later.

Leg 3 must read **the same package** as legs 1 and 2. Reading `@webpieces/ai-hook-rules`' own manifest and comparing it to an umbrella catalog pin is a latent universal false positive the day the umbrella's children stop moving in lockstep (they are all `0.4.616` today — verified — but only by construction of the umbrella's `dependencies` block).

**Range policy: SKIP `^`, `~`, `workspace:*`, exactly as fault D does.** One shared spec asserts this for both. Not "block ranges" — that would be a second spelling of "is this pin in sync".

**Fail open** on any unreadable leg, logged as a **distinct `ALLOW_FAIL_OPEN` verdict with `reason=pin-unreadable`** — never a free-text suffix, or abstentions become uncountable.

### When it fires

- **Never** in a repo with no linked worktrees: first predicate is `tree.kind !== 'worktree' → return null`, one enum compare on an already-memoized `classify()`. Zero I/O.
- **Never** on `Read` — exempted at the **top** of the guard, before any file access. Consequence, stated in `guards/L1-location.md`: *the audit trail will never carry a V verdict for a Read, so "no V line" does not mean "no skew".*
- **Never** on read-only inspection Bash (`ls`, `cat`, `grep`, `rg`, `pwd`, `git status|log|diff|show`, `git worktree list`) — `R=n` is required and `ReadOnlyInspectionScan` already computes it.
- **Never** on an Edit of `pnpm-workspace.yaml`, `package.json`, or `webpieces.config.json` in the tree being blocked — the same unconditional carve-out that already exists at `runner.ts:107` for `webpieces.config.json`, extended by two filenames. This is what makes the cure typable from inside the block.
- **Fires** on any other Write/Edit or Bash whose resolved target tree is a linked worktree of this main tree, with a differing pin.

### EXACT deny message

```
BLOCKED by L1 row 8 (trinary-version-skew). Three @webpieces versions must be identical and they are not:

  worktree pin   0.4.612   /Users/dean/wp/.claude/worktrees/agent-3f2a/pnpm-workspace.yaml
                           catalog: '@webpieces/nx-webpieces-rules'
  maintree pin   0.4.616   /Users/dean/wp/pnpm-workspace.yaml
  installed      0.4.616   the binary judging this very call
                           /Users/dean/wp/node_modules/@webpieces/nx-webpieces-rules

The guard hooks are registered ABSOLUTE ($CLAUDE_PROJECT_DIR), so the MAINTREE governs every tree.
This worktree is being linted, validated and built by 0.4.616 while its own manifest asks for 0.4.612.
Rules, config keys, error text and cures differ between releases, so anything you build, edit or commit
in here was judged by a release this tree did not ask for.
Your command is fine; the tree it would run in is not.

Fix ONE of these, then re-run.

  1. MAKE ALL THREE THE SAME.
       a) cd '/Users/dean/wp' && pnpm install
       b) Edit /Users/dean/wp/.claude/worktrees/agent-3f2a/pnpm-workspace.yaml
          set  '@webpieces/nx-webpieces-rules': 0.4.616
       c) cd '/Users/dean/wp/.claude/worktrees/agent-3f2a' && pnpm install
          (the worktree needs its OWN node_modules to run nx, vitest and eslint. Only the guard
           BINARY comes from the maintree - installing here does not change which release judges you.)

  2. DO THE WORK IN THE MAINTREE. It is never blocked by this guard:
       cd '/Users/dean/wp' && <your command>

STILL ALLOWED HERE, RIGHT NOW: every Read; read-only inspection (ls, cat, head, grep, rg, pwd,
git status/log/diff/show, git worktree list); pnpm install; git pull / git fetch; and Edits to
pnpm-workspace.yaml, package.json and webpieces.config.json.

Run each command EXACTLY as written. The allowlist matches the WHOLE command, so appending anything
(even && git status) makes it a different command and it is rejected - that is not the guard blocking
its own cure. Only these may be added: a leading `cd <dir> &&` (single-quote a path containing spaces),
a trailing `2>&1`, and `| tail -N`.

Do NOT lower the MAINTREE pin to 0.4.612 to match. That installs an older release for every tree,
including this session's own governor.
Do NOT re-type the command or conclude the harness ate your `cd`. It did not; the pins disagree.
Note: `!` bang commands bypass every hook. This guard does not see them.
```

---

## 4. FILE-BY-FILE CHANGE LIST

### PR1 — delete `CoordinatorWorktreeGuard` (plan item C). Source-only, zero managed-surface bytes.

| File | Action |
|---|---|
| `src/core/coordinator-worktree.ts` | **DELETE** |
| `src/core/coordinator-worktree.spec.ts` | **DELETE** |
| `src/core/runner.ts` | EDIT — drop the guard import, the `coordinatorInWorktreeBlock` dispatch (~L281-288), and the `agent = UNKNOWN_AGENT` param threaded through `runBash` (L152-159), `l1Classify` (L294-302), `l1LocationBlock` (L304-352), `runBashInternal` (L414, L456). Delete the "parallel L-1 hook may still have denied it" comment (L344). |
| `src/adapters/hook-core.ts` | EDIT — delete `agentIdentityOf()` (L113-118), the agent construction in `handleBash` (L132-133), the payload `agent_type` field. **KEEP `payload.agent_id`** — `StreamIdentity` reads it independently at L320. |
| `src/core/l1-rows.ts` | EDIT — delete ROW 3 + use cases 12/13/14/15/16, `L1Agent` (L33-34), `'coordinator-in-worktree'` from `L1BlockId` (L44), `L1Classification.coordinator` (L70, L91, L99), `L1Row.a` (L158) and its `matches()` leg (L170); fix the "seven rows" docblock (L192-202). |
| `src/core/l1-doc.ts` | EDIT — delete `renderTwoLayerForceToRoot()` (L92-131) and its call; delete the A legend/provenance/column and the "Rows 3, 5 and 7" / "Row 12 is the incident" prose. |
| `guards/L1-location.md` | **REGENERATE** via `pnpm guards:generate` and commit. Byte-locked at `l1-matrix.spec.ts:269` — never hand-edit. |
| `src/core/l1-matrix.spec.ts` | EDIT — delete the 4 row-3/guard-only `it` blocks; adapt `everyClassification` (80→40), `label()`/`rowFor`, row-count, contiguity, `atRoot` file list. |
| `src/core/effective-tree.ts` | EDIT — comments only (L63, L75-79, L264). **Keep** the worktree-vs-foreign classification; rewrite its justification. |
| `src/core/effective-tree.spec.ts` L130, `src/core/decision-log.ts` L126, `src/core/log-stream.ts` L90 | EDIT — comment-only, remove references to deleted symbols. |

### PR2 — absolute registration (A) + L-1 deletion (B). **ATOMIC — must be one PR.**

Shipping absolute registration while still expecting `guarantee-root.sh` (or the reverse) leaves upgrading trees registered-but-missing = exit 127 = **silent unguarded allow**, which no drift check can name. That state must never be published.

| File | Action |
|---|---|
| `src/bin/hook-registration.ts` | EDIT — `shimCommand()` L85 → `` sh "$CLAUDE_PROJECT_DIR/${SHIM_MARKER}" ${bin} `` (**one** spelling; no second absolute variant). `expectedEntries()` collapses to `bins.map(guardHookEntry)`. Delete `GUARANTEE_ROOT_MATCHER`/`_COMMAND`/`_ENTRY`/`_SURFACE` and `guaranteeRootRegisteredButMissing()`. `managedSurfaceDrift()` → `SHIM_SURFACE` + `REGISTRATION_SURFACE`. Rewrite the "why two of them are RELATIVE" header (L8-42). **`isManagedCommand()` KEEPS matching the literal `.claude/webpieces/guarantee-root.sh` as `LEGACY_GUARANTEE_ROOT_MARKER`, removal-only.** |
| `src/bin/guarantee-root.ts`, `guarantee-root.spec.ts`, `templates/guarantee-root.sh` | **DELETE** |
| `src/bin/setup.ts` | EDIT — delete `applyGuaranteeRoot()` (L102-117) and its call site (L493) and the install-half imports. **KEEP** `removeGuaranteeRootFile()`/`removeGuaranteeRootHook()`, made unconditional — one-way migration, deletion release named in the PR body. |
| `src/bin/upgrade-shim.ts` | EDIT — replace `writeGuaranteeRoot(root)` (L55) with `fs.rm` of the legacy path when present; keep `repairRegistrationAt(root)`; rewrite `reportRepairs()` (L72-84) and the module header (L14-33). `verifyRepaired()` unchanged. |
| `src/bin/shim.ts` | EDIT — `shimStaleDenyReason()` (L677): "THREE things" → two; delete the `GUARANTEE_ROOT_MARKER` / "SILENT UNGUARDED ALLOW" clause, the "registered RELATIVE so each tree runs its own release" clause, "rewrites … to the three-hook form", and the now-inverted "a settings.json still on the OLD two-absolute-hook form reports here too". Headers L96-101, L551-575, L631. **Also delete the fault-X `WP_BORROW_NOTE` at L206** — under absolute registration `BIN_ROOT` can never differ from `ROOT`, so it is dead code, and it teaches the opposite of row 8. |
| `src/core/l0-matrix.ts` | EDIT — fault-S surface array (L199) → `[SHIM_MARKER, REGISTRATION_SURFACE]`; drop the marker import (L7); rewrite L176-183 and both cure discriminators. |
| `src/core/log-streams.ts`, `log-stream.ts`, `decision-log.ts` L276-280, `runner.ts` L344 | EDIT — delete `LMINUS1_CD_STREAM` + its `ALL_LOG_STREAMS` entry; delete the "JOIN with `L-1-cd/`" caveat everywhere. |
| `src/adapters/hook-core.ts` L271-273 | EDIT — "three managed things" comment. |
| `scripts/generate-guard-docs.ts` | EDIT — drop the `renderGuaranteeRoot` import (L6) and template write (L45-47). |
| `templates/ai-hook.sh` | **REGENERATE** via `pnpm guards:generate` and commit (byte-locked at `setup.spec.ts:140` to the LOCAL renderer). |
| `webpieces.guard-matrix.md` template | **REGENERATE** (byte-locked to `renderGuardMatrixDoc()`). |
| `src/bin/three-hook-registration.spec.ts` | **RENAME → `registration.spec.ts`** and invert (see §6). |
| `src/bin/setup.spec.ts` L63 | EDIT — `.not.toContain('$CLAUDE_PROJECT_DIR')` → `.toContain(...)`. |
| `src/bin/bin-process-entry.spec.ts` L8, L146 | EDIT — drop the `guaranteeRootPath` import and existence assertion. |
| `nx-webpieces-rules/src/lib/__tests__/publish-packages.spec.ts` L20 | EDIT — repoint the "Mirrors guarantee-root.spec.ts" cross-reference. |
| `templates/claude-settings-hook.json` | REWRITE to the two absolute entries, **and add a spec locking it to `expectedEntries([GUARDS_BIN, RULES_BIN])`** (it is currently wrong in three ways with nothing pinning it). |
| `README.md` L34-60, `GUARD_MATRIX.md` (delete the ~95-line L-1 section + rows 30/52 + the JOIN paragraph 86-88), `guards/L0-tooling.md` 245/251, `docs/tooling-logs.md` 40/66/102/121-131, `docs/plans/guard-layer-toggles.md` 3/75-87/149/201 | EDIT — shim shape #6: every doc naming a removed symbol updated in the same diff. |
| `decisions/0004-one-governor-absolute-registration.md` | **NEW** — supersedes `0003-three-hooks-per-tree-governance.md`. Do **not** rewrite 0001/0002/0003; repoint the inbound links from `GUARD_MATRIX.md:52` and `:204`. |
| `backlog/bug-a-cd-inside-the-workspace-did-not-persist-*.md`, `bug-l1-prescribes-a-subagent-remedy-*.md`, `bug-a-write-with-an-absolute-path-*.md` | CLOSE. `bug-webpieces-dot-dir-layout-*.md` — update (the L-1 log-placement anomaly is gone). |
| **`.claude/**`** | **NOT ONE BYTE.** See §5. |

### PR4 — pin bump + settings flip (produced by running the tool, not by hand)

`pnpm-workspace.yaml`, `pnpm-lock.yaml`, `.claude/settings.json`, `.claude/webpieces/ai-hook.sh` modified; `.claude/webpieces/guarantee-root.sh` deleted. Nothing else.

### PR5 — the trinary guard (plan item D). Source-only.

| File | Action |
|---|---|
| `src/core/pinned-webpieces-version.ts` | **NEW** — `PinnedWebpiecesVersion.read(root)`: read `<root>/package.json`, take the `@webpieces/nx-webpieces-rules` specifier; literal → that is the pin; `catalog:` → anchored line-scan of `<root>/pnpm-workspace.yaml`'s top-level `catalog:` block. Returns `string \| null`. First 64KB only. Per-root process cache. |
| `src/core/l1-rows.ts` | EDIT — add `'trinary-version-skew'` to `L1BlockId`; `L1Classification.versionsInSync` replaces the deleted `coordinator`; add ROW 8 (array position after row 2, number 8 — precedent for number≠position is row 7) + its use cases. |
| `src/core/runner.ts` | EDIT — compute `versionsInSync` in `l1Classify`; dispatch row 8 from `l1LocationBlock`; in `runInternal`, resolve the target tree via `dotWebpieces.treeRoot(path.dirname(input.filePath))` and add the `pnpm-workspace.yaml` / `package.json` carve-out beside the existing `webpieces.config.json` pass at L107. |
| `src/core/l1-doc.ts` + `guards/L1-location.md` | EDIT + **REGENERATE** — V legend, provenance paragraph, row 8, the Read-audit-gap sentence. |
| `src/core/l1-matrix.spec.ts` | EDIT — V dimension, row 8, contiguity. |
| `src/core/trinary-version-skew.spec.ts` | **NEW** — see §6. |

---

## 5. RELEASE SEQUENCE

Current release = **N** (`0.4.616`). The repo runs the **published** binary, one release behind local source; `managedSurfaceDrift()` validates the shim, `guarantee-root.sh` and the `settings.json` registration **together, against the RUNNING binary**. That is the whole constraint.

| # | What | Managed-surface drift during it |
|---|---|---|
| **1** | **PR1** — delete `CoordinatorWorktreeGuard`. | **Zero.** No `.claude/` bytes, no managed renderer. Fault S cannot fire. `index.ts` exports only `run`, so the guard was never a published surface — no consumer compile break. |
| **2** | **PR2** — absolute registration + L-1 deletion, atomic. | **Zero, for the entire life of the branch.** Published N still expects three hooks + `guarantee-root.sh` + its own `renderShim()` bytes, and all three are still exactly that on disk. vitest exercises the NEW local source via `tsconfig.base.json` paths, so the inverted specs prove the new shape while nothing is live. |
| **3** | **PUBLISH** — merge PR1 then PR2; release CI publishes **N+1**. | Inert here: pin still N, `node_modules` still N, `.claude/` still N-shaped. **Verify the published artifact, not `pnpm pack`:** `npm view @webpieces/ai-hook-rules@N+1` must declare `bin` including `wp-upgrade-shim`, and its `templates/` must contain `ai-hook.sh` and **not** `guarantee-root.sh`. |
| **4** | **PR4** — the flip. | **Fault S fires. By design. Recoverable without a human.** |
| **5** | **PR5** — trinary guard, then publish, then a pin-bump-only PR. | Zero managed-surface change; no fault S. The only new behaviour is skewed worktrees start blocking. |

### The fault-S transition, step by step (PR4)

Do this **in the primary clone, at the repo root, in a session you will restart afterwards.**

1. **Edit `pnpm-workspace.yaml`:** `'@webpieces/nx-webpieces-rules': 0.4.616` → `N+1`. Fault D reads `DRIFT_DECLARED` out of `pnpm-lock.yaml`, not this file, so this edit alone trips nothing.
2. **`pnpm install`.** Rewrites lock and `node_modules` together, so declared and installed never disagree — D still silent. From this instant the running binary is **N+1**.
3. **Next tool call → FAULT S.** Claude Code fires the hooks registered at session start (still the old three-hook form; all three still resolve). The committed shim's drift guard sees lock == `node_modules` == N+1, so it execs the N+1 binary. N+1's `enforceCommittedShim()` calls `managedSurfaceDrift(governingShimRoot())` — derived from `__dirname`, i.e. this primary clone — and reports REGISTRATION drift (disk has 3 entries, N+1 wants 2) and SHIM drift (renderer bytes changed).
4. **The cure is reachable, three-fold.** `shimStaleDenyReason()` prints `cd <root> && pnpm exec wp-upgrade-shim`; `UPGRADE_SHIM_ALLOW_JS` is in `L0_ALLOWLIST` and `CD_PREFIX_ERE_ANCHORED` tolerates the leading `cd`; `shimStaleRecoveryDecision` independently returns `allow-cure` inside `enforceCommittedShim`; and the still-live old L-1 hook permits a `cd` to the repo **root** (it only denies cds into subdirectories lacking `.git`).
5. **Run it.** N+1's `runUpgradeShim()` writes `.claude/webpieces/ai-hook.sh` from N+1's renderer, `fs.rm`s `.claude/webpieces/guarantee-root.sh`, and `repairRegistrationAt(root)` removes **all three** managed entries (H1 only because `isManagedCommand` still knows the legacy marker) and appends the two absolute ones. `verifyRepaired()` re-asks the guard's own predicate and exits non-zero if anything still differs. **Exit 0 = the block is lifted for the very next call.**
6. **Why it lifts even though Claude Code snapshots hooks at session start:** the guard measures *files on disk*, not live wiring. The old wiring keeps running for the rest of this session, and the two relative guard hooks still point at a file that exists (just rewritten), so guarding is continuous. Only the L-1 entry now points at a deleted file → exit 127 → non-blocking → cds go unjudged for the remainder of this session. That is the intended end state anyway. **Do not spelunk into subdirectories in this session; restart it once the commit is made.**
7. **Commit exactly what the tool produced.** Eyeball the settings diff: two entries, matchers `Write|Edit|MultiEdit|Bash|Read` and `Write|Edit|MultiEdit`, both commands `sh "$CLAUDE_PROJECT_DIR/.claude/webpieces/ai-hook.sh" <bin>`, and `grep -c guarantee-root .claude/settings.json` = 0.

**NEVER hand-edit `.claude/settings.json`** — not in PR2 (published N would report drift, fault-S-block every call, and its own cure would rewrite the file *back* to three hooks: a human edit and the cure fighting each other, the one genuinely unrecoverable shape in this plan), and not in PR4 (hand-written bytes were not produced by the running renderer, so they re-open fault S with no diagnosis).

---

## 6. TESTS

### Positive

**PR1**
- `l1-matrix.spec.ts`: 40-point cross product over `K/V/R/G/P`; row-number contiguity holds with row 3 retired; `guards/L1-location.md` byte-identical to `renderL1Doc()`.

**PR2**
- `registration.spec.ts` (renamed): fresh install writes **exactly 2** PreToolUse commands, **both containing `$CLAUDE_PROJECT_DIR`**; no `Bash`-only entry exists; the rendered shim still passes `sh -n`.
- **Migration case:** stage the current three-hook relative form (the literal bytes now in `.claude/settings.json`) → `registrationStale()` is **true** → `repairRegistration()` yields exactly the two absolute entries **and no `guarantee-root` substring anywhere in the file**.
- `managedSurfaceDrift()` per-surface cases reduced to 2 surfaces; no case names a third.
- `templates/claude-settings-hook.json` locked to `expectedEntries([GUARDS_BIN, RULES_BIN])`.
- `wp-upgrade-shim` end-to-end: given a tree with all three legacy surfaces, it removes the file, rewrites both settings paths, and `verifyRepaired()` exits 0.
- `log-layout.spec.ts` still green with `L-1-cd` removed from `ALL_LOG_STREAMS` — **check first whether it scans a fixture or a live tree**; a dev machine with a pre-existing `.webpieces/logs/L-1-cd/` would otherwise fail.

**PR5** — `trinary-version-skew.spec.ts`, fixtures only, no real git:
- Fake linked worktree = a `.git` **FILE** containing `gitdir: <main>/.git/worktrees/feat-a`. Dependency-free, exercises the exact on-disk marker `classify()` keys off.
- **Silent on an ordinary repo:** no worktrees → Bash, Write, Edit all pass, and a recording stub proves **zero file reads** happened.
- **Fires from `file_path`:** absolute Write into the worktree while cwd is main → block. (This is the measured hole; this spec is its regression pin.)
- **Fires from a leading `cd`** (both bare and single-quoted spellings) and **from cwd**.
- **Does not fire across repos:** `.git` is a DIRECTORY; or a worktree whose `gitdir:` points at a *different* primary.
- **In sync → silent.** Ranges (`^0.4.616`) → **silent** (shared spec with fault D).
- **THE BLOCKING TEST — cure reachability, asserted twice:** (a) regex **every literal command and path out of the rendered deny** and assert `isAllowed('Bash', cmd, '')` accepts each, and that each named Edit target passes the carve-out; (b) drive the real runner under a live row-8 block with those exact bytes and assert each is allowed. Do **not** assert "an allowlist entry exists".
- **Read is free and silent:** Read of a worktree file under an active skew → pass, with the stub proving no manifest was read.
- **Fail-open matrix:** no `pnpm-workspace.yaml`; `catalog:` present but no `@webpieces` entry; a `catalogs:` named block with no top-level `catalog:`; absent manifest — each passes, each logs `ALLOW_FAIL_OPEN reason=pin-unreadable`. Plus: a well-formed in-sync fixture **never** produces that verdict.
- **Agent identity is never consulted:** same call with `agent_id` absent, present, and naming a different tree → identical verdict.

### Negative — removed spellings must not return

1. **THE ORPHANED-H1 SPEC (highest value in the whole suite):** a settings file carrying a legacy `guarantee-root.sh` entry **is reported STALE**, and `repairRegistration()` removes it. If `isManagedCommand()` ever stops matching that literal, `managedEntries()` ignores the legacy entry, `registrationStale()` reports 2-have/2-want = CLEAN, `dropManagedEntries()` leaves it, and every upgraded repo keeps a **live L-1 hook denying every subdirectory `cd`** while `wp-upgrade-shim` reports success.
2. `expectedEntries()` returns no command containing `guarantee-root` for **any** bin set, including rules-only and guards-only.
3. `grep -rn "guarantee-root" packages/tooling/ai-hook-rules/src` returns **only** the `LEGACY_GUARANTEE_ROOT_MARKER` definition and its removal path.
4. `shimCommand()` has exactly **one** exported spelling — no absolute/relative pair.
5. **Contradiction sweep:** grep the rendered shim and every L0/L1 message; assert **no message instructs an install "here, in this tree" as a governor fix**, and that fault X's `WP_BORROW_NOTE` is gone. Row 8's cure step (c) is the only surviving place that tells an agent a fresh worktree needs its own `node_modules`, and it says why.
6. No source file names `AgentIdentity`, `UNKNOWN_AGENT`, `CoordinatorWorktreeGuard`, `coordinator-in-worktree`, `L1Agent`, or `LMINUS1_CD_STREAM`.
7. `backwards-compat-reviewer` green, with the `removeGuaranteeRoot*` one-way-migration justification and its deletion release stated in the PR2 body.

---

## 7. OPEN DECISIONS FOR THE HUMAN

**1. Catalog-bump fan-out — how does a stale worktree get synced?**
After a main-tree bump, every live worktree blocks until its **tracked** `pnpm-workspace.yaml` is edited — and that edit will conflict on the eventual 3-point merge from main. The sanctioned sync route is `pnpm wp-start-upsert-pr`, which is **not** on the L0 allowlist (and `git merge` was deliberately removed from it).
**Recommendation: allowlist `pnpm wp-start-upsert-pr` as an L0 cure and name it as fix 1(d) in row 8's message** — merging main brings the catalog line across with no hand edit and no conflict. Ship this **with** PR5, not after.

**2. Does `webpieces.config.json` also anchor to the primary?**
Today config resolution is per-tree, so a worktree's `webpieces.config.json` governs its own rules while the main tree's *binary* governs enforcement — the same split this plan removes for hooks, left in place for policy. That is exactly the state row 8 exists to make loud.
**Recommendation: YES, but not in this plan.** Anchor config resolution to `primaryRoot()` in a **PR6**, after PR5 has landed and the trinary guard has been live for a release. Reason: it is a behaviour change with a much larger blast radius (every rule toggle in every worktree), it is not required for anything in PRs 1–5, and doing it now would make PR2's transition impossible to reason about. Once it lands, row 8's premise strengthens from "the binary is main's" to "the binary *and* the policy are main's", and the guard's message should be updated to say so.

**3. Is leg 3 trinary or quaternary?**
A worktree that ran `pnpm install` has its own `node_modules`, and that is what nx/vitest/eslint load for its build — a fourth version nothing guards.
**Recommendation: keep it trinary.** The fourth is *build* tooling, not the *governor*, and fault D already catches declared-vs-installed inconsistency for any tree the shim runs in. Guarding it would mean blocking a worktree for a state that does not affect who judges it. Revisit only if a real incident traces to it.

**4. Worktree-rooted sessions.**
`$CLAUDE_PROJECT_DIR` is per-session, so a session launched inside a worktree makes *that* worktree the "main tree" for hook registration. "The main tree governs all trees" is then false for that session.
**Recommendation: do not forbid it — make it harmless.** Every governor derivation in PR5 goes through `governingShimRoot()`/`primaryRoot()`, never `$CLAUDE_PROJECT_DIR`, so row 8 is correct either way (it resolves the real primary and compares against it). State this explicitly in `decisions/0004`. This is the reason the pure-sh design was rejected — it cannot make that guarantee, because it runs before the exec.

**5. Deletion date for `removeGuaranteeRootFile()`/`removeGuaranteeRootHook()`.**
They only ever delete the old shape, so they are a one-way migration, not a shim. But they are dead weight once every consumer has upgraded.
**Recommendation: delete them two releases after N+1**, and write that release number into the PR2 body so `backwards-compat-reviewer` has a date to hold you to.

---

## 8. RISKS AND ROLLBACK

| Risk | Severity | Mitigation |
|---|---|---|
| **Orphaned H1.** `isManagedCommand()` stops matching `guarantee-root.sh` → repair silently leaves a live L-1 hook denying every subdirectory `cd`, with `wp-upgrade-shim` reporting success and no drift check able to name it. | **Highest.** One line. | Keep the literal as `LEGACY_GUARANTEE_ROOT_MARKER`, removal-only, with the negative spec #1 in §6. This is the single most important line in the change. |
| **Hand-editing `.claude/settings.json` in PR2.** Published N reports drift, fault-S-blocks everything, and its own cure rewrites the file back — human and cure fighting. | **Unrecoverable without a human editing under a block.** | Gate: `git diff --name-only \| grep '^\.claude/'` must be **empty** in PR2. Stated as an explicit prohibition in the PR body. |
| **Registered-but-missing during migration.** A release with absolute registration but no `guarantee-root.sh` deletion (or vice versa) = exit 127 = silent allow. | High | PR2 is **atomic** — A and B in one PR, one release. Never split. |
| **`wp-upgrade-shim` prints nothing and exits 0.** The bin is inert (a packaging regression, cf. 0.4.575 shipping with no `bin` at all). | Medium | Step-3 gate verifies the **published** artifact declares its bins, not `pnpm pack`. If output is empty, **do not loop** — that is the deny's own warning; inspect `node_modules/@webpieces/ai-hook-rules/package.json`. |
| **Row 8 blocks its own cure** (the repo's worst historical failure shape). | Medium | Two structurally independent escapes: the `runInternal` carve-out (in code, not regex) and "work in the main tree" (needs no allowlist at all). Plus the blocking cure-reachability test that re-submits the deny's literal bytes. |
| **Fail-open swallows the guard.** Three `null` returns all map to in-sync; a refactor makes it universally silent. | Medium | Distinct `ALLOW_FAIL_OPEN` verdict + a spec that a well-formed in-sync fixture never emits it. |
| **Leg 3 reads the wrong package.** Comparing `ai-hook-rules`' version to an umbrella catalog pin is a latent universal false positive. | Medium | Read `@webpieces/nx-webpieces-rules`' manifest at the resolved bin root; spec asserts all three legs name the same package. |
| **`!` bang commands bypass every hook.** | Accepted, unfixable here | The deny says so. Do not claim coverage. |
| **First tool call after the pin bump is a fault-S block in every consumer tree simultaneously.** | Accepted, by design | The deny text is the only instruction a blocked agent gets, so it must already be correct **in release N+1** — which is why PR2 rewrites `shimStaleDenyReason()` in the same diff as the registration change. |

### Rollback

- **PR1, PR2, PR5 before publish:** ordinary `git revert`. No consumer is affected; nothing under `.claude/` moved.
- **After N+1 is published, before PR4:** do nothing. N+1 is inert in this repo. Publish N+2 reverting PR2's source if needed.
- **After PR4 (the flip):** revert the pin in `pnpm-workspace.yaml` to N, `pnpm install`, then run **N's** `wp-upgrade-shim` — it rewrites `.claude/webpieces/guarantee-root.sh`, restores the three-hook registration, and `verifyRepaired()` confirms it. The migration is symmetric because both directions go through the same repair function; the only asymmetry is that N's `isManagedCommand()` already recognises absolute shim commands (they differ from the relative form by text, so `sameAs` catches them). **Verify this rollback path with a spec in PR2** — stage the two-absolute form and assert N-shaped `expectedEntries()` reports it stale.
- **Row 8 alone (PR5):** it is a single `L1_ROWS` entry. Removing the row disables the guard with no surface change and no fault S.

---

# AMENDMENTS — human requirements added AFTER the planning run

The planning workflow was launched before these were stated, so §1–§8 above do not reflect them. They are
REQUIREMENTS, not suggestions. Where an amendment contradicts a recommendation above, the amendment wins.

## A1 — Leg 4 is IN. Decision #3 above is REVERSED, and its stated reason does not hold.

§7 decision #3 recommends staying trinary, on the grounds that *"fault D already catches
declared-vs-installed inconsistency for any tree the shim runs in."*

**Under this plan's own design, the shim NEVER runs in a worktree.** With absolute registration
`$0` is `$CLAUDE_PROJECT_DIR/.claude/webpieces/ai-hook.sh`, so `ROOT` and `BIN_ROOT` are both the MAIN
tree, and the drift guard compares the main tree's pin against the main tree's install. A worktree's own
`node_modules` is therefore examined by nothing at all — the very check the recommendation leans on is
the one absolute registration removes.

So the guard checks **3 always, 4 when present**:

| # | location | when | why it binds |
|---|---|---|---|
| 1 | `<maintree>/pnpm-workspace.yaml` pin | always | |
| 2 | `<worktree>/pnpm-workspace.yaml` pin | always (tracked, per-branch) | |
| 3 | `<maintree>/node_modules/@webpieces/*` | always | the guard binary that judges every call |
| 4 | `<worktree>/node_modules/@webpieces/*` | **when present** | nx, vitest and the eslint plugin run IN that tree and load THIS copy |

Leg 4 is common, not exotic: `pnpm add <any-dep>` inside a worktree creates `node_modules` there. It does
NOT change which release *judges* the tree (that is leg 3, and the deny message above is right to say
so), but it does change which release *builds, lints and tests* it — and nothing else checks it.

## A2 — Double-walk as a free detector (cheap, not authoritative)

`ConfigFile.findConfigFile()` (`rules-config/src/config-file.ts:71-80`) returns at the FIRST hit. Have it
collect ALL hits on the walk it already performs: finding TWO `webpieces.config.json` files proves a
worktree nested inside the primary, and therefore 3–4 versions in play.
**Limitation, state it:** only catches worktrees nested inside the primary (`.claude/worktrees/*`). A
sibling worktree (`git worktree add ../foo`) has no second config above it. `dotWebpieces.gitDirs()` stays
the authoritative test. Use double-walk as a free signal, never as the answer.

## A3 — A blocked SUBAGENT must be told to ESCALATE

The deny text in §3 tells the reader to fix the pins. A **subagent cannot do that**: the maintree is
outside its tree, and per this session's measurements it may not even still be in the tree it was
launched in. Add to the message, when the caller is a subagent:

> Report to your coordinator: "my worktree is on X, the maintree is on Y — one of us must move.
> Usually: both `git pull` onto the same main, then ONE `pnpm install` in the maintree."

Escalation is the prescribed action, not a local fix. (Precedent: the original bug report's fix item 3 —
"the subagent cannot fix its own anchor; only the launch can.")

## A4 — The cure is a GIT cure. Say so first.

Because the pin is TRACKED, alignment is a consequence of the trees being on the same commit:

    same git hash -> same tracked pnpm-workspace.yaml -> same pin -> ONE `pnpm install` in the maintree
      -> every tree agrees, by construction

Lead the cure with that chain — "usually this is just maintree `git pull` and the worktree `git pull` onto
the same main" — before the per-file edit instructions. The edit instructions stay as the fallback for
when the trees genuinely must differ.

## A5 — Audit EVERY verdict, allow and deny

Record all four versions, both tree paths, and the verdict on every evaluation, not just blocks. This
session burned hours establishing "which hook ran" solely because nothing logged it; do not repeat that
one layer up. Extend the fields that landed with the `shim=`/`bin=` work rather than opening a new
stream, and make the whole thing greppable by one field name.

## A6 — Every worktree is a peer; and CLONE is the real escape hatch

The check is over the whole SET, not the caller's pair. If worktree A is aligned and B is not, the agents
in B are already broken and nothing has told them. Enumerate via `WorktreeService` (note: it fails SOFT
to `[]` — acceptable for advice, must never be read as "no worktrees exist" when deciding to BLOCK) and
NAME which worktrees disagree and at what version.

Add the escape hatch no current message offers, in this order:
1. **align the pins** (normal case, via A4's git cure);
2. **use a separate CLONE** if you genuinely need a different version — a clone has its own
   `node_modules`, its own config and its own install, so it is genuinely independently governed, and
   `EffectiveTreeResolver` already classifies it `foreign` (hands off). A worktree is *structurally
   incapable* of this, since it borrows the maintree's binary;
3. **serialize** — do the work in the maintree, one thing at a time.

When the worktree count is high, say so and prescribe clone-or-serialize rather than silently accepting
an N+1th. Independently supported: parallel worktrees measured ~3.2x total test time under CPU
contention (`bug-parallel-subagents-in-worktrees-collapse-the-build-gate`).

## A7 — The skew IS the loop. Blocking it is the point, not a side effect.

Decision #3's original framing treated leg 4 as a tidiness question. It is not. A main-tree/worktree
manifest mismatch is precisely the shape that produced the founding incident: an agent is shown a fault
measured against one tree, runs the prescribed cure in another, the cure succeeds, nothing the guard
measures changes, and the guard re-denies. **Five identical no-op `pnpm install`s and a fabricated theory
about the harness later, a human had to untangle it.**

So the guard's purpose is stated as loop-prevention, not hygiene: it must fire BEFORE an agent can burn
turns on a cure that cannot converge, and its message must say why the obvious local fix will not work.
Any future proposal to soften it to a warning must answer: what stops the five-install loop instead?

## A8 — After the flip, each worktree carries a DEAD tracked copy of the shim. Decide its fate.

Consequence of absolute registration that §1–§8 does not address. `.claude/webpieces/ai-hook.sh` is
TRACKED, so every worktree has one. After the flip:

- only the MAINTREE's copy is ever executed (`$0` is the maintree path);
- `managedSurfaceDrift()` measures `governingShimRoot()` — resolved from the running module, i.e. the
  maintree — so a worktree's copy is **never validated**;
- when main's shim changes, every worktree's tracked copy goes stale **silently**, and surfaces later as
  a merge conflict on a file no human edited.

And the human's specific concern: if `wp-upgrade-shim` is ever run FROM a worktree, it rewrites THAT
tree's committed shim, which then must be committed on that branch or it shows as dirty — a tracked-file
mutation the agent did not intend and may not notice.

Requirements:
1. The version-sync guard's audit line records WHICH tree's committed shim is live vs merely present.
2. `wp-upgrade-shim` must refuse to run in a linked worktree, naming the maintree as the place to run it.
   Repairing a copy nothing executes is a no-op that reads as success — the exact non-convergent shape
   A7 exists to prevent.
3. Decide (OPEN, needs the human): does the worktree's copy stay tracked-but-inert, or does the flip also
   stop committing it? Staying tracked is simplest and keeps a fresh clone bootstrappable; the cost is
   recurring merge noise on a dead file. Recommendation: keep it tracked, and let the sync guard's
   same-git-hash rule make the copies identical anyway.

---

# HUMAN DECISIONS — recorded 2026-08-10

- **Direction: APPROVED.** Absolute registration, delete L-1 + `CoordinatorWorktreeGuard`, add the
  version-sync guard.
- **§7 #1 — allowlist `pnpm wp-start-upsert-pr` as an L0 cure: YES.** Human's reason: "that works better
  when there is no PR, and updates the PR when there is one." Ship it WITH PR5.
- **§7 #2 — anchor `webpieces.config.json` to the primary: DEFER.** Human's reason: if webpieces versions
  are kept in sync by matching git hashes, the configs are ~99% likely to match anyway. Revisit after the
  sync guard has been live a release; do not block PRs 1-5 on it.
- **§7 #3 — trinary vs quaternary: QUATERNARY (see A1).** 3 always, 4 when present.
- **The in-flight PR `dean/worktree-hook-anchor`: ABANDON**, salvaging only what the new design reuses.
  Human's words: "we are going for gold and waiting on the right solution, not a hack."

---

# REVISION 2 — ONE PR (human decision, 2026-08-10), and the #639 baseline

## The baseline moved: PR #639 landed a FOURTH managed surface

`55cbb04` — "Manage CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR=1 as a fourth webpieces settings surface"
(`managed-env.ts`, `envStale()`, `applyManagedEnv()`). Every count in §2 shifts: `managedSurfaceDrift()`
goes from FOUR surfaces to THREE, not three to two.

**#639's stated premise is the one this session measured false.** Its header defends the relative
registration as deliberate — *"H2/H3 are registered RELATIVE on purpose … so each git worktree runs its
own release, binary and pin."* Measured: a worktree has no `node_modules`, so `ai-hook.sh` walks UP and
executes the PRIMARY's binary (`readlink -f` resolved it to `<primary>/node_modules/@webpieces/…`). A
worktree runs its own SCRIPT and its own CONFIG. It never runs its own release or binary. The relative
registration protects a property that is not delivered — which is the whole case for going absolute, and
the human's verdict: *"the relative experiment failed miserably, sending us looping with AI trying to
solve it and not quite getting there with too many variables."*

#639 is still a keeper: it makes L-1 redundant by PREVENTING cwd drift rather than curing it, and it
proved `.claude/settings.json` → `env` is a committed, validated, self-healing home for a setting. Keep
the surface; drop the premise.

## ONE PR — everything mergeable in a single change

Human decision: PRs 1-4 collapse into ONE. That works for every SOURCE change. It does NOT work for the
`.claude/settings.json` flip, and that is a hard mechanical constraint, not a preference:

> The PUBLISHED binary validates the registration against ITS OWN expected shape. Flipping
> `.claude/settings.json` in the same PR means release N reports drift, fault-S-blocks every tool call,
> and **its own cure rewrites the file back to the old form** — the human edit and the cure fighting each
> other. §8 names this "the one genuinely unrecoverable shape in this plan."

So the shape is **one PR, then one mechanical commit**:

### THE PR (all source; ZERO bytes under `.claude/`)

1. **Absolute registration** — the expected form in `hook-registration.ts` becomes two entries,
   `sh "$CLAUDE_PROJECT_DIR/.claude/webpieces/ai-hook.sh" <bin>`. `repairRegistration()` migrates the old
   three-entry relative form; keep the legacy marker as `LEGACY_GUARANTEE_ROOT_MARKER`, removal-only
   (§8's single highest risk).
2. **Delete L-1** — `guarantee-root.ts`, its spec, its template, `LMINUS1_CD_STREAM`, the 12 exported
   symbols, `GUARANTEE_ROOT_SURFACE` from the drift set. `wp-upgrade-shim` deletes the committed file.
3. **Delete `CoordinatorWorktreeGuard`** — the guard, its spec, L1 row 3 (retired, never renumbered),
   `AgentIdentity`, `UNKNOWN_AGENT`, and the now-dead identity parameter threaded through `runner.ts`.
4. **Add the version-sync guard** — L1 row 8, QUATERNARY per A1 (3 always, 4 when present), with A3
   (subagent escalates), A4 (git cure first), A5 (audit every verdict), A6 (all worktrees are peers;
   clone-or-serialize), A7 (loop-prevention is the purpose), A8 (`wp-upgrade-shim` refuses to run in a
   worktree).
5. **Allowlist `pnpm wp-start-upsert-pr`** as an L0 cure and name it in row 8's message (§7 #1, approved).
6. **Retire the half-moved `commands.upsertPr` / `commands.mergeComplete`.** `setup.ts:236-262`
   (`migrateGuardHints`) still silently MOVES the retired flat keys into `guardHints` — a config fallback
   accepting the old shape, i.e. shim shape #3, which CLAUDE.md bans. Delete the migration; add both keys
   to `RETIRED_CONFIG_KEYS` so the loader REJECTS them naming `commands.guardHints.prCreationOrPush` /
   `.mergeInProgress`. `retired-config-keys.spec.ts` already asserts every entry actually fails the load.
7. **THE DOC SWEEP — scan EVERY doc, not just the ones that are easy to find.** Per CLAUDE.md shim shape
   #6, a message or doc that teaches the removed model is itself a defect and fails
   `backwards-compat-reviewer`. Sweep for: "registered RELATIVE", "each git tree is governed by its own
   release", "its own release, binary and pin", "guarantee-root", "L-1", "H1", "three managed surfaces",
   "run the install HERE, in this worktree", "subagent bound to that worktree". Known homes:
   `CLAUDE.md`, `GUARD_MATRIX.md`, `guards/*.md` (generated — fix the RENDERER), `decisions/*`,
   `packages/tooling/ai-hook-rules/README.md`, every `responsibilities.md`, `setupDebugging.md`,
   `managed-env.ts`'s own header (#639's premise), `hook-registration.ts`'s header, and
   `ai-hook.sh`'s `WORKTREE_NOTE` / `WP_BORROW_NOTE` (rewrite per R3b — nuance, not inversion).
   **Grep is the deliverable here: the sweep is not done until the greps return only intended hits.**

### THEN, after N+1 publishes: ONE MECHANICAL COMMIT

Bump the `catalog:` pin, `pnpm install`, take the fault-S block, run `pnpm exec wp-upgrade-shim` (which
is allowlisted through its own block), commit exactly what the tool produced. **Never hand-edit
`.claude/settings.json`.** Full step-by-step in §5.
