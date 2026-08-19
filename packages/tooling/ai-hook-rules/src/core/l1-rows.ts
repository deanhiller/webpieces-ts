import type { TreeKind } from './effective-tree';

// ---------------------------------------------------------------------------
// L1 — the LOCATION layer, as data.
//
// L1 answers four questions: do we govern this call at all, does the directory still EXIST, is the
// WRONG AGENT standing here, and is the agent stranded away from the root? Drawn as a decision matrix
// that is SEVEN ordered rows over five dimensions (K/A/R/G/P), first match wins.
//
// This module holds those rows, and l1-doc.ts renders them into guards/L1-location.md — the doc a human
// reads on GitHub. A unit test locks that file byte-identical to the renderer, and the guard itself
// CONSULTS L1_ROWS to decide which structural block fires (see runner.l1LocationBlock). Doc and code
// come from the SAME array, so they cannot drift.
//
// This module is deliberately import-free at runtime (only a type-only import above), so
// `pnpm guards:generate` can load it without the package's transitive dependencies.
// ---------------------------------------------------------------------------

/**
 * The K dimension as a CLASSIFICATION carries — one concrete tree, never the `pw` union.
 *
 * `p` and `w` are the same PROJECT and every rule-scoped guard treats them alike; the doc writes the
 * pair as `pw` in the row's MATCHER (below), which is a different vocabulary on purpose.
 */
export type L1Kind = 'f' | 'm' | 'o' | 'p' | 'w';

/** The K value a ROW matches on. `pw` matches both `p` and `w`; `-` is the wildcard. */
export type L1KindMatch = 'f' | 'm' | 'o' | 'w' | 'pw' | '-';

/** R and G are yes/no, written `y`/`n` in the doc, with `-` for "does not matter". */
export type L1Flag = 'y' | 'n' | '-';

/**
 * V is the same one boolean wearing the doc's own letters: `n` the webpieces versions do NOT agree
 * between this worktree and the main tree, `y` they do.
 *
 * This dimension used to be A (`c` coordinator / `s` subagent). It was replaced rather than removed
 * because agent identity was measured untrustworthy as a proxy for "which tree am I in" — a
 * worktree-isolated agent auto-reaped at a turn boundary silently resumes on the primary clone. A
 * version read off the PATH being acted on cannot lie in that way.
 */
export type L1VersionSync = 'y' | 'n' | '-';

/** What L1 does with a row. The labels are the doc's own action codebook (see GUARD_MATRIX.md). */
export type L1ActionKind = 'exempt' | 'down' | 'block';

/**
 * WHICH structural block a blocking row dispatches to. This is the field that makes the array
 * load-bearing rather than decorative: runner.l1LocationBlock looks the row up and switches on it,
 * so deleting a row from the array removes the block.
 */
export type L1BlockId = 'trinary-version-skew' | 'force-to-root' | 'missing-directory';

/**
 * The row number for L1's PRE-STAGE — `misplacedCdBlock`, which decides from command TEXT before a
 * tree has been resolved, and therefore cannot be classified over the five dimensions rows 1-6 use
 * (asking L1_ROWS to classify it would need the very resolution its answer determines).
 *
 * ZERO rather than a seventh row, deliberately. It has to appear in the table — an L1 block the
 * generated doc did not describe is precisely the drift the table exists to prevent, and it was
 * carrying a `KNOWN GAP` comment saying so. But numbering it 7 would assert it sits in the same
 * first-match scan as the others, which is the one thing that is not true about it. Row 0 says
 * "decided before the scan" in the number itself. `renderL1Doc()` PRINTS this row above the six, so
 * `row=0` in the L1 log joins to a line the reader can actually find.
 */
export const L1_PRESTAGE_ROW = '0';

/**
 * One point in the five-dimensional space L1 classifies over. Data-only → a class, per CLAUDE.md.
 *
 * The dimensions are exactly the doc's legend: K (tree kind of the resolved target), V (webpieces versions in sync or
 * subagent), R (provably read-only inspection), G (invokes git/gh), P (root or subdirectory).
 */
export class L1Classification {
    // eslint-disable-next-line @typescript-eslint/max-params -- five dimensions is the matrix's shape
    constructor(
        readonly kind: L1Kind,
        readonly versionsSkewed: boolean,
        readonly readOnly: boolean,
        readonly git: boolean,
        readonly atRoot: boolean,
    ) {}

    /**
     * The classification the RUNNER enforces on, built from the resolved tree and the caller.
     *
     * `'outside'` maps to `p`, and that is not a typo. TreeKind `'outside'` is produced by
     * effective-tree.ts (git has no answer for the directory) and consumed NOWHERE, so a command in no git repo is
     * judged against the governed repo exactly as if it stood in it. Row 2 (`o` → L2) describes what
     * SHOULD happen and is deliberately unreachable from here until the "Not done" fix in
     * guards/L1-location.md lands — exempting `o` alone opens a `cd /tmp &&` bypass of every L2 guard,
     * so the two ship together or neither does. Mapping it to `p` here is what preserves today's
     * behaviour (a `git` command from /tmp is still force-to-root blocked); it is not an endorsement.
     */
    // eslint-disable-next-line @typescript-eslint/max-params -- mirrors the constructor it delegates to
    // webpieces-disable no-function-outside-class -- a named constructor for this data class, not a service: it takes the runner's TreeKind and returns the same class, so there is nothing to inject
    static forEnforcement(
        treeKind: TreeKind,
        versionsSkewed: boolean,
        readOnly: boolean,
        git: boolean,
        atRoot: boolean,
    ): L1Classification {
        const kind: L1Kind = treeKind === 'foreign' ? 'f'
            : treeKind === 'missing' ? 'm'
            : treeKind === 'worktree' ? 'w' : 'p';
        return new L1Classification(kind, versionsSkewed, readOnly, git, atRoot);
    }
}

/** The `act` cell of a row: the doc's literal label, plus the machine-readable kind behind it. */
export class L1Action {
    constructor(readonly label: string, readonly kind: L1ActionKind) {}
}

export const ACT_EXEMPT = new L1Action('2 exempt', 'exempt');
export const ACT_DOWN = new L1Action('→ L2', 'down');
export const ACT_BLOCK = new L1Action('4 block', 'block');

/**
 * The CURE a blocking row prescribes.
 *
 * `runnable` is the axis that matters to the tests: a cure that is a command must, once applied,
 * actually stop the row from matching (cure reachability). Row 3's cure is an INSTRUCTION — "spawn a
 * subagent bound to the worktree" — which no allowlist can accept and no reclassification can model,
 * so it declares `runnable: false` and is asserted only on the deny text.
 */
export class L1Cure {
    constructor(
        /** How the doc's `why` column spells it. */
        readonly summary: string,
        /** A substring that MUST appear in the deny text the guard emits for this row. */
        readonly denyMention: string,
        readonly runnable: boolean,
    ) {}
}

/**
 * One row of the "L1 use cases" table: what you SEE, the state it puts you in, the verdict, the fix.
 *
 * The four text fields are rendered VERBATIM into the doc. `classification` is the same case expressed
 * in the matrix's own vocabulary so the tests can run it through the matcher — it is test/enforcement
 * data, never rendered, which is why a use case that exercises the FILTER or the L0 allowlist (neither
 * of which is a row) can carry `null` there.
 */
export class L1UseCase {
    // eslint-disable-next-line @typescript-eslint/max-params -- four verbatim doc cells plus the classification behind them
    constructor(
        readonly num: number,
        readonly symptom: string,
        readonly state: string,
        readonly verdict: string,
        readonly fix: string,
        readonly classification: L1Classification | null = null,
    ) {}
}

/** One row of L1's decision table. Data-only → a class, per CLAUDE.md. */
export class L1Row {
    // eslint-disable-next-line @typescript-eslint/max-params -- five dimension cells plus act/why/cure/blockId/useCases
    constructor(
        readonly num: number,
        readonly k: L1KindMatch,
        readonly a: L1VersionSync,
        readonly r: L1Flag,
        readonly g: L1Flag,
        readonly p: 'root' | 'sub' | '-',
        readonly action: L1Action,
        /** The `why` cell, verbatim. */
        readonly why: string,
        readonly cure: L1Cure | null,
        readonly blockId: L1BlockId | null,
        readonly useCases: readonly L1UseCase[],
    ) {}

    matches(c: L1Classification): boolean {
        if (!this.kindMatches(c.kind)) return false;
        if (this.a !== '-' && (this.a === 'n') !== c.versionsSkewed) return false;
        if (!flagMatches(this.r, c.readOnly)) return false;
        if (!flagMatches(this.g, c.git)) return false;
        return this.p === '-' || this.p === (c.atRoot ? 'root' : 'sub');
    }

    private kindMatches(kind: L1Kind): boolean {
        if (this.k === '-') return true;
        if (this.k === 'pw') return kind === 'p' || kind === 'w';
        return this.k === kind;
    }
}

// R and G are one boolean each behind a `y`/`n`/`-` cell, so one helper answers for both. (A is the
// same shape but spelled `c`/`s`, and is matched inline above so the row literals read like the doc.)
// webpieces-disable no-function-outside-class -- pure predicate for L1Row.matches above, in this data module
function flagMatches(cell: L1Flag, value: boolean): boolean {
    if (cell === '-') return true;
    return (cell === 'y') === value;
}

/**
 * THE seven L1 rows, in first-match-wins order.
 *
 * Rows 3, 5 and 7 are the structural blocks and they run as ONE step (runner.l1LocationBlock) so they
 * can never be reordered by accident. Every other row is a hand-down or an exemption, i.e. "L1 has no
 * objection" — which is why only those three carry a blockId.
 *
 * Row 7 (`m`, the vanished directory) sits LAST only because row numbers are stable across releases —
 * they are printed in the doc and logged as `row=`, so renumbering rows 1-6 to slot it in front would
 * silently invalidate every existing reference. Position costs nothing here: `m` is matched by no other
 * row, so first-match reaches it wherever it sits.
 */
export const L1_ROWS: readonly L1Row[] = [
    new L1Row(1, 'f', '-', '-', '-', '-', ACT_EXEMPT, 'different git repo — hands off', null, null, [
        new L1UseCase(1,
            '`cd repositories/vendored && git commit` goes through untouched',
            '`f` / `y` / - — row 1',
            'ALLOW_EXEMPT',
            'none needed — jurisdiction is judged on the RESOLVED target, after the `cd`; a different git repo is hands-off',
            new L1Classification('f', false, false, true, false)),
    ]),
    new L1Row(2, 'o', '-', '-', '-', '-', ACT_DOWN, 'see "Not done" below', null, null, []),
    // ROW 3 IS RETIRED — it was coordinator-in-worktree, deleted with CoordinatorWorktreeGuard when the
    // guard hooks went ABSOLUTE (one governor, so the filesystem/governance split it policed became
    // unconstructible). The NUMBER is never reused: row numbers are identity here — they are printed in
    // denies, logged as `row=`, and cited in guards/L1-location.md — so renumbering would silently
    // re-point every historical reference. Its replacement is row 8.
    new L1Row(8, 'w', 'n', 'n', '-', '-', ACT_BLOCK,
        'this worktree pins a DIFFERENT @webpieces than the main tree that governs it',
        new L1Cure('align the pins (same git hash -> same tracked pin -> install in each tree), work in the main tree, or use a separate clone',
            '@webpieces version SKEW', false),
        'trinary-version-skew', [
            new L1UseCase(12,
                'a worktree on an older branch pins `0.4.612` while the main tree runs `0.4.616`, and `cd <wt> && pnpm build` is blocked',
                '`w` / `n` / `n` — row 8',
                'BLOCK_AI_CURE',
                'Option 1 (preferred): `git pull` BOTH trees onto the same main, then `pnpm install` in each tree that has a node_modules — the pin is tracked, so the same commit gives both trees the same version<br>Option 2: do the work in the main tree, which this guard never blocks<br>Option 3: if the tree genuinely needs a DIFFERENT version, use a separate CLONE — a clone gets its own governance. That is the answer to "I need a different version", never to "I need to install here": a worktree MAY have its own node_modules (nx, vitest and the eslint plugin all load from it), it just may not hold a different @webpieces version<br>Do NOT: lower the MAIN tree\'s pin to match — that downgrades every tree, including this session\'s own governor',
                new L1Classification('w', true, false, false, false)),
            new L1UseCase(16,
                'a SUBAGENT hits the same block inside `.claude/worktrees/agent-XXXX`',
                '`w` / `n` / `n` — row 8; in-repo placement is still `w`',
                'BLOCK_AI_CURE',
                'A subagent CANNOT fix this alone — the main tree is outside its tree, and a worktree-isolated agent may not even still be in the tree it was launched in (measured: auto-reaped at a turn boundary, resumed on the primary). Report to the coordinator: "my worktree is on X, the main tree is on Y — one of us must move"<br>Do NOT: expect exemption because it sits under the repo — K is git\'s `--git-common-dir` answer, not a path test',
                new L1Classification('w', true, false, false, false)),
        ]),
    new L1Row(4, 'pw', '-', '-', 'n', '-', ACT_DOWN, 'force-to-root has no jurisdiction', null, null, [
        new L1UseCase(5,
            '`ls` from `packages/http/` runs normally',
            '`pw` / `n` / - — row 4',
            'ALLOW (handed to L2)',
            'none — force-to-root has no jurisdiction over non-git commands',
            new L1Classification('p', false, true, false, false)),
        new L1UseCase(6,
            '`pnpm test` from `packages/http/` runs normally',
            '`pw` / `n` / - — row 4',
            'ALLOW (handed to L2)',
            'none — deliberately untouched, so package-local test runs stay natural',
            new L1Classification('p', false, false, false, false)),
        new L1UseCase(10,
            '`echo "cd sub && git push"` passes',
            '`pw` / `n` / `root` — row 4',
            'ALLOW (handed to L2)',
            'none — the `cd` is inside quotes, so `ShellSegmentScan` never treats it as a scope escape',
            new L1Classification('p', false, false, false, true)),
        new L1UseCase(13,
            'the same command from a **subagent** runs normally',
            '`w` / `y` — row 8 does not match',
            'ALLOW (handed to L2)',
            'none — a subagent pinned to a worktree is the correct pattern',
            new L1Classification('w', false, false, false, false)),
        new L1UseCase(14,
            'inspection inside a SKEWED worktree still runs — `cd <worktree> && ls`/`cat`/`grep`',
            '`w` / `n` / `y` — row 8 does not match',
            'ALLOW (handed to L2)',
            'none — inspection is always open; so are the `Read` tool, `git -C <dir INSIDE this tree> …` and `git show <branch>:<file>`, none of which move you. `git -C <ANOTHER tree>` is a different matter: the harness refuses cross-tree git to a subagent, so it is never the cure for a skew — tell the MAIN agent instead',
            new L1Classification('w', true, true, false, false)),
    ]),
    new L1Row(5, 'pw', '-', '-', 'y', 'sub', ACT_BLOCK, '`cd <root> && <original>`',
        new L1Cure('`cd <root> && <original>`', 'Run git/gh commands from the repo root', true),
        'force-to-root', [
            new L1UseCase(7,
                '`git status` from `packages/http/` is blocked',
                '`pw` / `y` / `sub` — row 5',
                'BLOCK_AI_CURE',
                'Option 1 (preferred): `cd <root> && git status`',
                new L1Classification('p', false, false, true, false)),
            new L1UseCase(8,
                '`cd packages/http && git status` **typed from the root** is blocked',
                '`pw` / `y` / `sub` — row 5',
                'BLOCK_AI_CURE',
                'Option 1 (preferred): `cd <root> && git status`<br>Do NOT: assume it is allowed because you started at the root — the predicate is `effectiveCwd === root`, i.e. the DESTINATION',
                new L1Classification('p', false, false, true, false)),
            new L1UseCase(11,
                '`cd <subdir> && git push` blocked with the force-to-root message, NOT the gated-flow one',
                '`pw` / `y` / `sub` — row 5; force-to-root runs first',
                'BLOCK_AI_CURE',
                'Option 1 (preferred): `cd <root> && git push`, which then gets the push guard\'s real answer ← costs one extra turn by design; still blocked',
                new L1Classification('p', false, false, true, false)),
            new L1UseCase(17,
                'the printed cure REPLACES your `cd`, it does not stack in front of it',
                '`pw` / `y` / `sub` — row 5, on the cure itself',
                'BLOCK_AI_CURE',
                'Option 1 (preferred): run the printed line VERBATIM — `cd <root> && <the work>`, with your own leading `cd` dropped<br>Do NOT: paste `cd <root> && cd <subdir> && <work>`; `effectiveCwd` resolves the leading `cd`s left to right, so that lands in `<subdir>` again and re-fires this exact block',
                new L1Classification('p', false, false, true, false)),
        ]),
    new L1Row(6, 'pw', '-', '-', 'y', 'root', ACT_DOWN, '', null, null, [
        new L1UseCase(9,
            '`cd <root> && git status` passes from anywhere',
            '`pw` / `y` / `root` — row 6',
            'ALLOW (handed to L2)',
            'none — this IS the prescribed cure',
            new L1Classification('p', false, false, true, true)),
    ]),
    new L1Row(7, 'm', '-', '-', '-', '-', ACT_BLOCK, 'the directory is GONE — nothing can run there',
        new L1Cure('`cd <root> && <the work>`, never back through the dead path',
            'no longer exists', true),
        'missing-directory', [
            new L1UseCase(18,
                'every command from a worktree another agent REAPED mid-session is blocked',
                '`m` — row 7',
                'BLOCK_AI_CURE',
                'Option 1 (preferred): run the printed `cd <root> && <the work>` line — it does NOT route back through the dead path<br>Do NOT: re-`cd` into the worktree, or `git worktree add` it back expecting your uncommitted work; that work is gone',
                new L1Classification('m', false, false, true, false)),
            new L1UseCase(19,
                'the same block for a NON-git command there — `m` does not care about G',
                '`m` — row 7; K alone decides it',
                'BLOCK_AI_CURE',
                'Option 1 (preferred): the same printed line. A vanished cwd is not a git question — nothing at all can run in a directory that does not exist',
                new L1Classification('m', false, false, false, false)),
        ]),
];

/**
 * The use cases that exercise something that is NOT a row: the excludePaths FILTER (2, 3, 4) and the L0
 * allowlist that runs ahead of L1 (15).
 *
 * They are use cases of L1 all the same — "exempt" is what emerges when the filter empties the rule
 * list, and case 15 is the invariant that a cure stays reachable from every tree — so they stay in the
 * doc's one numbered table. They carry no classification because no row classifies them.
 */
export const L1_UNROWED_USE_CASES: readonly L1UseCase[] = [
    new L1UseCase(2,
        'Edit `repositories/vendored/foo.ts` allowed even on stale main',
        'filter — the path is in `excludePaths`',
        'ALLOW_EXEMPT',
        'none needed'),
    new L1UseCase(3,
        'Edit `packages/http/foo.ts` blocked on stale main',
        'filter keeps the rules → L2 fires',
        'BLOCK (at L2)',
        'that is L2\'s write-on-main verdict, not L1\'s — follow the L2 message'),
    new L1UseCase(4,
        'Edit `packages/http/foo.ts` judged even though the shell is in `/tmp`',
        'filter, on the TARGET path',
        '→ L2',
        'none — for file tools the cwd is irrelevant; do NOT `cd` anywhere to "fix" it'),
    new L1UseCase(15,
        '`cd <worktree> && pnpm install` still runs while row 8 is live — it is the CURE',
        'L0 allowlist, ahead of L1',
        'ALLOW',
        'none — a cure must stay reachable from every tree'),
];

/** Every use case, in the doc's numbering — the order the table is rendered and read in. */
// webpieces-disable no-function-outside-class -- pure accessor over the two arrays above, beside them in this data module
export function allL1UseCases(): readonly L1UseCase[] {
    const all = [...L1_ROWS.flatMap((row: L1Row): readonly L1UseCase[] => row.useCases), ...L1_UNROWED_USE_CASES];
    return all.sort((a: L1UseCase, b: L1UseCase): number => a.num - b.num);
}

/**
 * FIRST MATCH WINS — the one lookup the guard and the tests share.
 *
 * Never null: rows 1, 2 and 4/5/6 between them cover every kind, and rows 4/5/6 partition G × P, so a
 * classification that matched nothing would be a hole in the matrix. The totality test asserts exactly
 * that, which is why this returns L1Row rather than L1Row | null.
 */
// webpieces-disable no-function-outside-class -- the matcher over L1_ROWS, beside the array it reads
export function firstMatchingL1Row(c: L1Classification): L1Row {
    const row = L1_ROWS.find((r: L1Row): boolean => r.matches(c));
    if (row === undefined) throw new Error(`L1 matrix has a hole: no row matches ${JSON.stringify(c)}`);
    return row;
}
