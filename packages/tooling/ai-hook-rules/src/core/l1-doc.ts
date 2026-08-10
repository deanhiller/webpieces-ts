import { L1Row, L1UseCase, L1_ROWS, L1_PRESTAGE_ROW, allL1UseCases } from './l1-rows';

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


// The three questions L1 answers, the preamble and the filter — all prose, none of it row data.
// webpieces-disable no-function-outside-class -- first section of renderL1Doc's string, beside it in this module
function renderHead(): string[] {
    return [
        '# L1 — location',
        '',
        '**Goal: is this call ours to judge, is this tree governed by the release it asks for, and is git being run from the root?**',
        '',
        '**Config key: `location-guard` (proposed).** Force-to-root and trinary-version-skew both have **no',
        'config key today** and cannot be disabled; `excludePaths` is a top-level block, not a `hookGuards`',
        'entry.',
        '',
        '',
        '**Code:** `packages/tooling/ai-hook-rules/src/core/effective-tree.ts` (`EffectiveTreeResolver`,',
        '`TreeKind`) · `packages/tooling/ai-hook-rules/src/core/runner.ts` (`l1LocationBlock`,',
        '`filterByExcludedPaths`, the `foreign` check) · `.../force-to-root.ts` (`ForceToRootGuard`) ·',
        '`packages/tooling/ai-hook-rules/src/core/missing-directory.ts` (`MissingDirectoryGuard`) ·',
        '`packages/tooling/ai-hook-rules/src/core/version-sync.ts` (`VersionSyncGuard`,',
        '`WebpiecesVersions`).',
        '',
        'L1 answers four questions, and they are genuinely separate:',
        '',
        '1. **Do we govern this at all?** — the escape hatches, for other repos and non-governed paths.',
        '   Answered by asking GIT (`--git-common-dir`), never by path math: see the legend under **K**.',
        '2. **Does the directory still EXIST?** — row 7. A worktree reaped out from under a live shell leaves',
        '   a cwd that names nothing, and that state needs its own name and its own message, because the',
        '   remedy for "you are in a subdirectory" is a `cd` back into the very directory that is gone.',
        '3. **Is this tree governed by a release it did not ask for?** — row 8. A worktree MAY have its own',
        '   `node_modules` (nx, vitest and the eslint plugin all execute there and load from it), and when it',
        '   has none the shim\'s upward walk runs the main tree\'s binary. Either way the rule is the same and',
        '   holds whichever registration form — absolute or relative — is live in the consumer: the two trees',
        '   must PIN the same `@webpieces`, or the worktree is linted, validated and built by a release its',
        '   own manifest does not ask for. Asked of the PATH acted on, never of who is asking —',
        '   agent identity was measured untrustworthy for tree detection (a worktree-isolated agent whose tree',
        '   is auto-reaped at a turn boundary silently resumes on the primary clone).',
        '4. **Is the agent stranded away from the root?** — force-to-root, git/gh only. Agents forget where',
        '   they are constantly, and `cd` gives them two different ways to be wrong: a `cd` that stays INSIDE',
        '   the workspace PERSISTS to later calls (so the shell can be parked in a subdirectory left by an',
        '   unrelated command turns earlier), while a `cd` that LEAVES it is reset by the harness, which says',
        '   so — `Shell cwd was reset to <root>`. Neither can be assumed, which is why every remedy names the',
        '   root explicitly instead of telling the agent to `cd` first.',
        '',
        '## Preamble — resolve the target first (Bash only)',
        '',
        '`EffectiveTreeResolver.resolve()` computes `effectiveCwd`: the directory the command actually runs in,',
        'which is the shell\'s cwd unless the command leads with `cd <dir> &&`. **K is classified from',
        '`effectiveCwd`, not from the shell\'s cwd** — so "a foreign repo that `cd`s into ours" is not a cell,',
        'it is simply `pw` after resolution.',
        '',
        'That holds because K is resolved by ASKING GIT about `effectiveCwd`, not by testing whether the path',
        'is lexically under the governed root. It has to be said that way round: the resolver used to do the',
        'path test, and a linked worktree under `.claude/worktrees/**` therefore resolved `f` — every bash',
        'guard exempt in the one sandbox agents are told to work in. A sentence in this file asserted the',
        'opposite as fact for several releases, which is how it went unnoticed.',
        '',
        'Only a LEADING run of `cd`/`pushd` counts. A *trailing* `… && cd <exempt-tree>` must never',
        'retroactively pull a command out of scope — that would smuggle a root-level `git push` past the',
        'guards. Quoting is handled by `ShellSegmentScan`, so `echo "cd sub && git push"` is one opaque',
        'segment and its quoted `cd` is never picked up.',
        '',
        ...renderFilterSection(),
    ];
}

// `excludePaths` — a FILTER over the rule list, not a dimension of the table. Its own function because
// renderHead is at the 70-line method cap, and because this section is one self-contained argument.
// webpieces-disable no-function-outside-class -- prose section of renderL1Doc's string, beside it in this module
function renderFilterSection(): string[] {
    return [
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
        '| **K** | tree kind of the resolved target, from git\'s own dirs | `f` foreign repo (a DIFFERENT `--git-common-dir`) · `m` the directory does not exist · `o` outside any repo · `w` a LINKED worktree of ours (`--git-dir` ≠ `--git-common-dir`), wherever it sits on disk · `pw` ours (primary **or** worktree) |',
        '| **V** | do the `@webpieces` versions agree between this worktree and the MAIN tree | `n` skewed · `y` in sync |',
        '| **R** | command is provably read-only inspection | `n` · `y` |',
        '| **G** | command invokes git/gh | `n` · `y` |',
        '| **P** | position of the resolved target | `root` · `sub` |',
        '',
        'All of them are **Bash only**. Read/Write/Edit resolve their own target (`input.filePath`) and have no',
        'dimensions — the filter is all that applies to them. **The Read tool is never blocked by L1.**',
        '',
        'A linked worktree is deliberately **not** foreign: it is the same project, so the guards run against',
        'THAT tree\'s branch and cache. Every rule-scoped guard treats `p` and `w` alike, hence `pw`; row 8 below',
        'is the ONE place they separate, and it turns on **V** — the versions, read off the tree itself.',
        '',
        'PLACEMENT IS NOT IDENTITY. A worktree checked out INSIDE the repo — `<repo>/.claude/worktrees/agent-XXXX`,',
        'which is where Claude Code puts every agent worktree — is `w` exactly like a sibling `../feature-dir` one.',
        'K comes from git\'s own dirs (`--git-common-dir` is identical for every checkout of one repo,',
        '`--git-dir` differs only in a linked worktree), never from whether the path sits under the governed root.',
        'It used to short-circuit on that path test, so an in-repo worktree read as `f` — every bash guard exempt,',
        'and row 8 unreachable, for the only layout the harness actually produces. A nested clone under',
        '`repositories/**` still reads `f`, because its shared git dir is its own.',
        '',
        '`V` comes from reading manifests off disk — the MAIN tree\'s `pnpm-workspace.yaml` catalog pin, its',
        'installed `node_modules` version, this worktree\'s pin, and this worktree\'s own installed version when',
        'it has one (which it does the moment anyone runs `pnpm add` there). Three always, a fourth when',
        'present. Anything unreadable is NO OPINION, never skew: a guard that cannot measure must not block.',
        'It is deliberately NOT read from `agent_id`/`agent_type` — the dimension this replaced was, and a',
        'worktree-isolated agent was measured resuming on the primary clone after its tree was reaped, so who',
        'is asking cannot be trusted to say which tree is being acted on.',
        '',
        '`R` is `ReadOnlyInspectionScan` — the same paranoid "provably inert" test the unloadable-config escape',
        'hatch uses (allowlisted viewers/searchers only, no redirects, no `sed -i`).',
        '',
        '## Table',
        '',
        '| # | K | V | R | G | P | act | why |',
        '|---|---|---|---|---|---|---|---|',
        // Row 0 is the PRE-STAGE (`misplacedCdBlock`). It decides from command TEXT before a tree is
        // resolved, so it cannot be classified over the five dimensions rows 1-6 share — but it IS an
        // L1 block, and an L1 block the table did not describe is exactly the drift this table exists
        // to prevent. It is numbered 0, not 7, because it does not sit in the first-match scan; and it
        // is PRINTED because `row=0` in the L1 log has to join to something.
        `| ${L1_PRESTAGE_ROW} | – | – | – | – | – | 4 block | a \`cd\` that is not leading + literal, judged before any tree is resolved |`,
        ...L1_ROWS.map(tableRow),
        '',
        'Rows 3, 5 and 7 are the structural blocks, and they run as ONE step (`l1LocationBlock` in `runner.ts`)',
        'so they can never be reordered by accident — row 7 (the directory is gone) first, then row 8, then',
        'force-to-root. Row 7 is printed LAST above only because row numbers are stable across releases and',
        'renumbering 1-6 would invalidate every `row=` in the logs; `m` matches no other row, so its position',
        'in the scan is immaterial. All three sit after the L0',
        'allowlist, after the `f` check, and after the `excludePaths` filter and the config-sync check. So a',
        'cure (`cd <worktree> && pnpm install`) still reaches any tree: that is L0\'s invariant, and row 8 does',
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
        'Row 12 is the incident that produced table row 8, and it is a VERSION SKEW incident — which is why',
        'the row that replaced it measures versions rather than agent identity. The coordinator ran',
        '`git worktree add`, `cd`\'d in,',
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
        '`effective-tree.ts` (git has no answer for the directory) carrying `governedRoot`, and **no code branches on it**, so a',
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
        '| trinary-version-skew (row 8), V, R | `ai-hook-rules/src/core/version-sync.ts` | `VersionSyncGuard`, `WebpiecesVersions` |',
        '| force-to-root (row 5) | `ai-hook-rules/src/core/force-to-root.ts` | `ForceToRootGuard` |',
        '| the directory is gone (row 7) | `ai-hook-rules/src/core/missing-directory.ts` | `MissingDirectoryGuard` |',
        '| the filter | `ai-hook-rules/src/core/runner.ts` | `filterByExcludedPaths` |',
        '| `excludePaths` shape | `rules-config/src/exclude-hook-paths.ts`, `validate-config.ts`, `retired-config-keys.ts` | `ExcludePaths`, `validateExcludePaths` |',
        '',
    ];
}
