import { L1Row, L1UseCase, L1_ROWS, allL1UseCases } from './l1-rows';

// ---------------------------------------------------------------------------
// guards/L1-location.md, rendered from L1_ROWS.
//
// Same arrangement as l0-matrix.renderGuardMatrixDoc(): one join('\n') of literal markdown lines with
// the ROW DATA interpolated from the array the guard consults. Everything that is not row data — every
// prose section — is a literal line here, because that is the half a generator cannot own.
//
// A unit test (l1-matrix.spec.ts) locks guards/L1-location.md byte-identical to renderL1Doc(), and
// `pnpm guards:generate` rewrites the file. So the table in the doc IS the array, not a description of
// it. This module, like l1-rows.ts, has no runtime imports outside this pair so the generator can load
// it without the package's transitive dependencies.
// ---------------------------------------------------------------------------

/** A dimension cell: the wildcard renders bare, every value renders as code. */
// webpieces-disable no-function-outside-class -- pure cell formatter for renderL1Doc below, in this render module
function cell(value: string): string {
    return value === '-' ? '-' : `\`${value}\``;
}

// webpieces-disable no-function-outside-class -- pure row formatter for renderL1Doc below, in this render module
function tableRow(row: L1Row): string {
    const dims = [row.k, row.a, row.r, row.g, row.p].map(cell).join(' | ');
    // Row 6 has no `why` — an EMPTY cell is `| |`, not `|  |`. Two spaces would render the same in a
    // browser and fail the byte-lock, which is the whole point of locking bytes rather than markdown.
    const why = row.why === '' ? ' ' : ` ${row.why} `;
    return `| ${row.num} | ${dims} | ${row.action.label} |${why}|`;
}

// webpieces-disable no-function-outside-class -- pure row formatter for renderL1Doc below, in this render module
function useCaseRow(useCase: L1UseCase): string {
    return `| ${useCase.num} | ${useCase.symptom} | ${useCase.state} | ${useCase.verdict} | ${useCase.fix} |`;
}

/**
 * Render guards/L1-location.md.
 *
 * Split into three consecutive halves purely to stay inside the method-line budget — the join order is
 * what makes them one file, so keep them adjacent and keep the byte-lock test as the arbiter.
 */
// webpieces-disable no-function-outside-class -- pure string builder over L1_ROWS, beside the array it reads
export function renderL1Doc(): string {
    return [
        ...renderHead(),
        ...renderTable(),
        ...renderUseCases(),
        ...renderTail(),
    ].join('\n');
}

// Why L-1's guarantee-root and L1's force-to-root are NOT the same rule. Its own function because
// renderHead is at the 80-line method cap, and because this section is one self-contained argument.
// webpieces-disable no-function-outside-class -- prose section of renderL1Doc's string, beside it in this module
function renderTwoLayerForceToRoot(): string[] {
    return [
        '## Force-to-root is TWO rules, in two layers — do not collapse them',
        '',
        'Collapsing them is how the `shellAtRoot` bug happened the first time, and the two now live in different',
        'layers, so it is worth stating plainly:',
        '',
        '| | judged by | what it judges | for | verdict |',
        '|---|---|---|---|---|',
        '| **L-1** | `.claude/webpieces/guarantee-root.sh` (POSIX sh, before any binary) | the `cd` **destination** of the command | **Bash** | ALLOW unless the destination is inside `$CLAUDE_PROJECT_DIR` and holds no `.git` — i.e. **sticky AND unguarded** |',
        '| **L1** | `gitFromSubdirBlock` (`runner.ts`) | the post-`cd` `effectiveCwd` | **git / gh only** | BLOCK unless it is THE root |',
        '',
        'They ask different questions. L-1 asks *"can the relative guard hooks launch there?"* — because the',
        'guard hooks are registered relative, and a hook that cannot resolve exits 127, which the harness treats',
        'as a non-blocking error and lets the call proceed UNGUARDED. It therefore ALLOWS a `cd` into a foreign',
        'nested clone (its own `.git`) and a `cd` outside the project (the harness resets the cwd next call),',
        'neither of which L1 would tolerate for a `git` command. L1 asks *"is this git command being run from the',
        'one root it is meant to run from?"*, which is a narrower question about a narrower set of commands.',
        '',
        'A denied `cd` never executes — PreToolUse denies the whole tool call before the shell moves — so there',
        'is no bad state to recover from and L-1 needs no cure command on any allowlist.',
        '',
    ];
}

// The three questions L1 answers, the preamble and the filter — all prose, none of it row data.
// webpieces-disable no-function-outside-class -- first section of renderL1Doc's string, beside it in this module
function renderHead(): string[] {
    return [
        '# L1 — location',
        '',
        '**Goal: is this call ours to judge, is the right AGENT making it, and is git being run from the root?**',
        '',
        '**Config key: `location-guard` (proposed).** Force-to-root and coordinator-in-worktree both have **no',
        'config key today** and cannot be disabled; `excludePaths` is a top-level block, not a `hookGuards`',
        'entry.',
        '',
        '',
        '**Code:** `packages/tooling/ai-hook-rules/src/core/effective-tree.ts` (`EffectiveTreeResolver`,',
        '`TreeKind`) · `packages/tooling/ai-hook-rules/src/core/runner.ts` (`l1LocationBlock`,',
        '`gitFromSubdirBlock`, `filterByExcludedPaths`, the `foreign` check) ·',
        '`packages/tooling/ai-hook-rules/src/core/coordinator-worktree.ts` (`CoordinatorWorktreeGuard`,',
        '`AgentIdentity`).',
        '',
        'L1 answers three questions, and they are genuinely separate:',
        '',
        '1. **Do we govern this at all?** — the escape hatches, for other repos and non-governed paths.',
        '2. **Is the WRONG AGENT standing here?** — the coordinator must not work inside a linked worktree.',
        '   Its governance is anchored to `$CLAUDE_PROJECT_DIR`, fixed at session start, which does NOT follow',
        '   a `cd`; a coordinator in a worktree therefore has its filesystem in one tree and its guards in',
        '   another, and every fault it is shown is measured against a tree it is not standing in. Work in a',
        '   worktree belongs to a **subagent bound to it**, which has both in one place.',
        '3. **Is the agent stranded away from the root?** — force-to-root, git/gh only. Agents forget where',
        '   they are constantly, and `cd` gives them two different ways to be wrong: a `cd` that stays INSIDE',
        '   the workspace PERSISTS to later calls (so the shell can be parked in a subdirectory left by an',
        '   unrelated command turns earlier), while a `cd` that LEAVES it is reset by the harness, which says',
        '   so — `Shell cwd was reset to <root>`. Neither can be assumed, which is why every remedy names the',
        '   root explicitly instead of telling the agent to `cd` first.',
        '',
        ...renderTwoLayerForceToRoot(),
        '## Preamble — resolve the target first (Bash only)',
        '',
        '`EffectiveTreeResolver.resolve()` computes `effectiveCwd`: the directory the command actually runs in,',
        'which is the shell\'s cwd unless the command leads with `cd <dir> &&`. **K is classified from',
        '`effectiveCwd`, not from the shell\'s cwd** — so "a foreign repo that `cd`s into ours" is not a cell,',
        'it is simply `pw` after resolution.',
        '',
        'Only a LEADING run of `cd`/`pushd` counts. A *trailing* `… && cd <exempt-tree>` must never',
        'retroactively pull a command out of scope — that would smuggle a root-level `git push` past the',
        'guards. Quoting is handled by `ShellSegmentScan`, so `echo "cd sub && git push"` is one opaque',
        'segment and its quoted `cd` is never picked up.',
        '',
        '## Filter — not a dimension (all tools)',
        '',
        '`filterByExcludedPaths` drops every rule excluded for this path: the **target path** for',
        'Read/Write/Edit, `effectiveCwd` for Bash. An empty rule list means allow. This is a filter, not a row:',
        '"exempt" is what emerges when the list empties.',
        '',
        '`excludePaths` is **ONE glob list** (canonical: `"excludePaths": ["repositories/**"]`). The',
        '`{ rules: [...], guards: [...] }` object is **retired and rejected**, with the union it must become',
        'named in the error. `wp-install-ai-hooks` migrates it in place.',
        '',
        'This used to be a tolerated fallback, justified here by "rejecting it would block every Bash/Edit',
        'including the edit that would fix it." **That was never true**, and the fallback it licensed is why',
        'consumer configs — this repo\'s own included — sat on the dead shape for releases. A Write/Edit whose',
        'target is `webpieces.config.json` is an unconditional **PASS** (see the L0 table above), and',
        '`pnpm install` has an installer bypass, so an invalid config can always be repaired from inside the',
        'block. Config rejection is self-recoverable by construction; see `retired-config-keys.ts` for the',
        'policy and the reasoning.',
        '',
    ];
}

// The legend, the table itself (ROW DATA), and the note on the two structural blocks.
// webpieces-disable no-function-outside-class -- second section of renderL1Doc's string, beside it in this module
function renderTable(): string[] {
    return [
        '## Legend',
        '',
        '| col | dimension | values |',
        '|---|---|---|',
        '| **K** | tree kind of the resolved target | `f` foreign repo · `o` outside any repo · `w` a LINKED worktree of ours · `pw` ours (primary **or** worktree) |',
        '| **A** | who is calling | `c` the coordinator · `s` a subagent (or a caller that cannot tell) |',
        '| **R** | command is provably read-only inspection | `n` · `y` |',
        '| **G** | command invokes git/gh | `n` · `y` |',
        '| **P** | position of the resolved target | `root` · `sub` |',
        '',
        'All of them are **Bash only**. Read/Write/Edit resolve their own target (`input.filePath`) and have no',
        'dimensions — the filter is all that applies to them. **The Read tool is never blocked by L1.**',
        '',
        'A linked worktree is deliberately **not** foreign: it is the same project, so the guards run against',
        'THAT tree\'s branch and cache. Every rule-scoped guard treats `p` and `w` alike, hence `pw`; row 3 below',
        'is the ONE place they separate, and it turns on **A**, not on the tree.',
        '',
        '`A` comes from `agent_id`/`agent_type` in the PreToolUse payload, which Claude Code sends **only inside',
        'a subagent**. Absent = the coordinator. A caller that cannot read the payload (the openclaw adapter,',
        'library consumers) resolves to `s` — fail open, never guess someone into a block.',
        '',
        '`R` is `ReadOnlyInspectionScan` — the same paranoid "provably inert" test the unloadable-config escape',
        'hatch uses (allowlisted viewers/searchers only, no redirects, no `sed -i`).',
        '',
        '## Table',
        '',
        '| # | K | A | R | G | P | act | why |',
        '|---|---|---|---|---|---|---|---|',
        ...L1_ROWS.map(tableRow),
        '',
        'Rows 3 and 5 are the two structural blocks, and they run as ONE step (`l1LocationBlock` in `runner.ts`)',
        'so they can never be reordered by accident — row 3 first, then force-to-root. Both sit after the L0',
        'allowlist, after the `f` check, and after the `excludePaths` filter and the config-sync check. So a',
        'cure (`cd <worktree> && pnpm install`) still reaches any tree: that is L0\'s invariant, and row 3 does',
        'not weaken it.',
        '',
    ];
}

// The use-case table (ROW DATA, in the doc's own numbering) and the two notes that follow it.
// webpieces-disable no-function-outside-class -- third section of renderL1Doc's string, beside it in this module
function renderUseCases(): string[] {
    return [
        '## L1 use cases',
        '',
        'Same row shape as L0: the **Fix** is literal or it is not a fix. `<root>` is the absolute workspace',
        'root — the messages name it explicitly rather than telling you to `cd` first, for the reason in the',
        'section head (neither the shell\'s cwd nor a `cd`\'s persistence can be assumed).',
        '',
        '| # | what you SEE (exact symptom) | state | verdict | Fix |',
        '|---|---|---|---|---|',
        ...allL1UseCases().map(useCaseRow),
        '',
        'Row 8 is the one that changed. It used to be ALLOWED, because the predicate was',
        '`shellAtRoot || cdsToRoot` — two variables OR\'d, so the same destination got opposite verdicts',
        'depending on where the shell happened to start. It is now one variable, `effectiveCwd === root`.',
        '',
        'Row 12 is the incident that produced table row 3. The coordinator ran `git worktree add`, `cd`\'d in,',
        'and worked there. An L0 version-drift fault then fired against the PRIMARY (pin `0.4.545` vs',
        '`node_modules` `0.4.526`) and prescribed `pnpm install` — which ran in the WORKTREE, internally',
        'consistent at `0.4.526`/`0.4.526`, so it succeeded, changed nothing in the measured tree, and the guard',
        're-denied. Five identical installs later the agent had invented a theory about the harness stripping',
        'its `cd` and handed the problem to the human. Note what row 15 says: the fix is NOT to deny that',
        'install. It is to make the split state unreachable, so the wrong-tree install is never plausible.',
        '',
    ];
}

// The known gap and the code anchors — prose, and the one section that must never be summarised away:
// three code comments point at it.
// webpieces-disable no-function-outside-class -- last section of renderL1Doc's string, beside it in this module
function renderTail(): string[] {
    return [
        '## Not done — `o` is not exempt yet',
        '',
        'Row 2 hands `\'outside\'` down to L2 rather than exempting it. `\'outside\'` is produced at',
        '`effective-tree.ts` (`gitRoot === null`) carrying `governedRoot`, and **no code branches on it**, so a',
        'command in no git repo is judged against the governed repo\'s branch and staleness state. That is a',
        'wrong verdict, and `exempt` is the right action.',
        '',
        '**It must not ship alone.** Jurisdiction comes from the shell cwd, not from what the command touches,',
        'so exempting `o` opens a bypass an agent reaches by typing `cd /tmp &&`:',
        '',
        '| command | today | with `o → exempt` alone |',
        '|---|---|---|',
        '| `cd /tmp && ls` | judged against the repo | exempt — **correct** |',
        '| `cd /tmp && git -C $REPO commit` | L2 guards fire | exempt — **every L2 guard bypassed** |',
        '| `cd /tmp && rm -rf $REPO/packages/http/src` | judged | exempt — **unguarded** |',
        '',
        'The two cases only separate once jurisdiction is judged on **what the command touches** (explicit',
        '`git -C` / `--work-tree`, then path arguments, then the `cd`, then the shell cwd), with the fail-safe',
        'rule that **any** resolved target inside `governedRoot` means `pw`. Ship the two together, or neither.',
        '',
        'Tracked in `backlog/bug-bash-guards-judge-the-shell-cwd-not-the-paths-the-command-touches.md` and',
        '`backlog/bug-outside-tree-kind-is-never-consumed-so-a-non-git-dir-is-judged-against-the-governed-repo.md`.',
        'That resolver has three consumers — L1\'s K, L2\'s scope dimension, and `excludePaths` on the Bash path',
        '— which is why the backlog says **fix once**.',
        '',
        '---',
        '',
        '',
        '## Code anchors',
        '',
        '| section | file | symbol |',
        '|---|---|---|',
        '| resolver, K | `ai-hook-rules/src/core/effective-tree.ts` | `EffectiveTreeResolver`, `TreeKind` |',
        '| the two structural blocks, in order | `ai-hook-rules/src/core/runner.ts` | `l1LocationBlock` |',
        '| coordinator-in-worktree (row 3), A, R | `ai-hook-rules/src/core/coordinator-worktree.ts` | `CoordinatorWorktreeGuard`, `AgentIdentity` |',
        '| force-to-root (row 5) | `ai-hook-rules/src/core/runner.ts` | `gitFromSubdirBlock` |',
        '| the filter | `ai-hook-rules/src/core/runner.ts` | `filterByExcludedPaths` |',
        '| `excludePaths` shape | `rules-config/src/exclude-hook-paths.ts`, `validate-config.ts`, `retired-config-keys.ts` | `ExcludePaths`, `validateExcludePaths` |',
        '',
    ];
}
