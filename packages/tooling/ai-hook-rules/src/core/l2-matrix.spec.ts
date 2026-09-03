import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect } from 'vitest';

import { loadTemplate } from '@webpieces/rules-config';

import { renderL2Doc } from './l2-doc';
import {
    L2Row, L2Tool, L2UseCase, L2_ROWS, L2_FAIL_OPEN_ROW, NOT_DONE, NO_ROW_EXIT, l2RowForReason,
    l2MappedReasons, allL2UseCases,
} from './l2-rows';
import { matrixL2Row, MATRIX_L2_UNROWED } from './decision-log';
import { BRANCH_STATE_MATRIX_DOC, branchStateMatrixPointer } from './l2-matrix-doc';
import { cureForMatrix, NO_CURE } from './matrix-cures';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');
const L2_DOC = path.join(REPO_ROOT, 'guards', 'L2-branch-state.md');

// The four classes behind the ONE `branch-state-guard` key. Their SOURCE is read, because the reason
// strings live there and nowhere else — the same technique l1-matrix.spec.ts uses to assert the runner
// still says what its rows claim.
const GUARD_FILES: readonly string[] = [
    'feature-branch-guard.ts',
    'read-stale-guard.ts',
    'stale-main-bash-guard.ts',
    'merged-branch-bash-guard.ts',
];

function guardSource(file: string): string {
    return fs.readFileSync(path.join(__dirname, 'rules', file), 'utf8');
}

/**
 * Every reason literal a guard passes to `allow` / `failOpen` / `block`.
 *
 * Matched off the call sites rather than off a hand-kept list, because a hand-kept list is precisely
 * what would go stale the first time somebody adds an exit. Template literals (the two reasons that
 * interpolate a PR number or a matched segment) are captured up to the first `${`, which is the prefix
 * PREFIX_REASON_ROWS matches on.
 */
function reasonLiteralsIn(source: string): readonly string[] {
    const out = new Set<string>();
    const call = /this\.(?:allow|failOpen|block)\(\s*ctx\s*,\s*[^,]+,\s*(?:'([^']*)'|`([^`$]*)(?:\$\{|`))/g;
    let match = call.exec(source);
    while (match !== null) {
        out.add(match[1] ?? match[2]);
        match = call.exec(source);
    }
    return [...out];
}

describe('L2 rows — the table itself', () => {
    it('has thirteen rows with unique numbers, in first-match order', () => {
        expect(L2_ROWS).toHaveLength(13);
        // The design's 1-5, then the cache divider, then the two composition rows, then 6-10. The
        // divider is numbered 11 and the composition rows 12/13, all PRINTED in position, because row
        // numbers are identity: they are logged as `row=` and cited in the doc, so renumbering to slot
        // them in would silently re-point every reference.
        expect(L2_ROWS.map((r: L2Row): number => r.num)).toEqual([1, 2, 3, 4, 5, 11, 12, 13, 6, 7, 8, 9, 10]);
        expect(new Set(L2_ROWS.map((r: L2Row): number => r.num)).size).toBe(13);
    });

    it('puts the on-main block ABOVE the cache divider — the most load-bearing order in the table', () => {
        const onMain = L2_ROWS.findIndex((r: L2Row): boolean => r.num === 5);
        const divider = L2_ROWS.findIndex((r: L2Row): boolean => r.num === L2_FAIL_OPEN_ROW);
        expect(onMain).toBeLessThan(divider);
    });

    /*
     * ON `main`, `B` TRACKS `R` — NOT `E`. Row 5 is the unconditional WRITE block, judged from the
     * branch alone above the cache divider; rows 6/7 are the freshness-gated pair, and Bash sits there
     * with Read because a build on a CURRENT `main` is harmless while a WRITE never is. Pinned as a
     * shape, because "restore the symmetry" is the edit that would either strand agents on a current
     * `main` again or let writes through on the first call of a session.
     */
    it('makes row 5 the WRITE-only block and rows 6/7 the freshness pair for B and R', () => {
        const toolsOf = (num: number): readonly L2Tool[] =>
            (L2_ROWS.find((r: L2Row): boolean => r.num === num) as L2Row).tools;
        expect(toolsOf(5)).toEqual(['E']);
        expect(toolsOf(6)).toEqual(['B', 'R']);
        expect(toolsOf(7)).toEqual(['B', 'R']);
        // No row judges Read alone any more — every state a Read is judged in also judges Bash.
        const readOnlyRows = L2_ROWS
            .filter((r: L2Row): boolean => r.tools.length === 1 && r.tools[0] === 'R')
            .map((r: L2Row): number => r.num);
        expect(readOnlyRows).toEqual([]);
    });

    it('gives every blocking row a LITERAL cure, and every allowing row none', () => {
        for (const row of L2_ROWS) {
            const blocking = row.action.kind === 'block';
            expect(blocking, `row ${row.num}`).toBe([2, 5, 6, 8, 9, 13].includes(row.num));
            if (blocking) {
                // A cure that points at documentation cannot be tested for reachability — see L0's
                // cure-reachability discipline, which caught a fault prescribing a renamed-away bin.
                expect(row.cure, `row ${row.num} cure`).toContain('`');
                expect(row.cure, `row ${row.num} cure`).not.toContain('see the docs');
            }
        }
    });

    it('covers every tool on at least one allowing and one blocking row', () => {
        for (const tool of ['B', 'R', 'E'] as readonly L2Tool[]) {
            const rows = L2_ROWS.filter((r: L2Row): boolean => r.tools.includes(tool));
            expect(rows.some((r: L2Row): boolean => r.action.kind === 'block'), tool).toBe(true);
            expect(rows.some((r: L2Row): boolean => r.action.kind !== 'block'), tool).toBe(true);
        }
    });
});

/**
 * THE JOIN. L1 dispatches from its rows; L2 maps its guards' REASON strings onto them (see l2-rows.ts
 * for why the four ladders are not one function). This is the test that makes the join real: a new exit
 * with no row fails the build instead of logging `row=-` forever.
 */
describe('L2 reason -> row is exhaustive over the four guards', () => {
    it('finds reason literals in every guard (the scraper itself is not silently empty)', () => {
        for (const file of GUARD_FILES) {
            expect(reasonLiteralsIn(guardSource(file)).length, file).toBeGreaterThan(3);
        }
    });

    it('maps every reason literal the four guards can log', () => {
        const unmapped: string[] = [];
        for (const file of GUARD_FILES) {
            for (const reason of reasonLiteralsIn(guardSource(file))) {
                if (l2RowForReason(reason) === null) unmapped.push(`${file}: ${reason}`);
            }
        }
        expect(unmapped, 'add these to L2_ROW_FOR_REASON in l2-rows.ts').toEqual([]);
    });

    it('maps every reason to a row that actually exists', () => {
        const numbers = new Set(L2_ROWS.map((r: L2Row): number => r.num));
        for (const reason of l2MappedReasons()) {
            const row = l2RowForReason(reason);
            expect(row, reason).not.toBeNull();
            expect(numbers.has(row as number), `${reason} -> row ${String(row)}`).toBe(true);
        }
    });

    it('claims no reason the guards cannot produce — the table has no dead entries', () => {
        const live = new Set<string>();
        for (const file of GUARD_FILES) for (const r of reasonLiteralsIn(guardSource(file))) live.add(r);
        // The one reason logged by the hook ADAPTER rather than by a guard: the webpieces.config.json
        // edit bypass, which exits before any guard runs. It is row 1 (the universal cure) and is
        // asserted here by name so the map cannot quietly accumulate entries nothing emits.
        live.add('config-bypass (feature-branch-guard skipped)');
        const dead = l2MappedReasons().filter((reason: string): boolean =>
            ![...live].some((emitted: string): boolean => emitted === reason || emitted.startsWith(reason)));
        expect(dead, 'these mapped reasons are emitted by nothing').toEqual([]);
    });

    it('stamps the row onto the MatrixRef the log writes', () => {
        expect(matrixL2Row('on-main')).toEqual({ layer: 'L2', row: '5' });
        expect(matrixL2Row('already-merged PR#123')).toEqual({ layer: 'L2', row: '8' });
        expect(matrixL2Row('no-forge')).toEqual({ layer: 'L2', row: String(L2_FAIL_OPEN_ROW) });
        // An unmapped reason renders as `-` — visible in the log, never absorbed into a default row.
        expect(matrixL2Row('something nobody mapped')).toEqual({ layer: 'L2', row: '-' });
    });

    it('keeps the un-rowed reference for the two kinds of line that are not a row', () => {
        expect(MATRIX_L2_UNROWED).toEqual({ layer: 'L2', row: '-' });
    });
});

/**
 * THE DELIVERED COPY. `guards/L2-branch-state.md` is for a human reading the repo; the rules-config
 * template is what an L2 block drops into `.webpieces/instruct-ai/` and names by absolute path. Both
 * come from renderL2Doc(), and this is what keeps that true — a delivered doc describing a table the
 * guards no longer have is worse than no doc, for the reason the "side door" incident already taught:
 * it looks covered.
 */
describe('the L2 matrix is DELIVERED to the AI, not just committed', () => {
    it('locks the rules-config template byte-identical to renderL2Doc()', () => {
        expect(loadTemplate(BRANCH_STATE_MATRIX_DOC), 'run `pnpm guards:generate`').toBe(renderL2Doc());
    });

    it('is the same bytes as the repo-facing doc, so there is exactly one L2 table', () => {
        expect(loadTemplate(BRANCH_STATE_MATRIX_DOC)).toBe(fs.readFileSync(L2_DOC, 'utf8'));
    });

    it('points the reader at the doc only when it was actually written', () => {
        expect(branchStateMatrixPointer('', '5')).toBe('');
        expect(branchStateMatrixPointer('/repo/.webpieces/instruct-ai/webpieces.branch-state-matrix.md', '5'))
            .toContain('/repo/.webpieces/instruct-ai/webpieces.branch-state-matrix.md');
    });

    // The row is the point: a bare "read this doc" is a page, a row number is the two lines that
    // explain this exact verdict — and it is the SAME number the log line carries.
    it('names the row that judged the call', () => {
        expect(branchStateMatrixPointer('/tmp/x.md', '8')).toContain('ROW 8');
    });

    // Interpolated into a REASON="…" shell assignment and then printf'd into a JSON string, exactly as
    // L0's pointer is: a quote or backslash corrupts the decision payload, not merely the prose.
    it('emits a JSON-safe pointer', () => {
        const pointer = branchStateMatrixPointer('/repo/.webpieces/instruct-ai/webpieces.branch-state-matrix.md', '5');
        expect(pointer).not.toContain('"');
        expect(pointer).not.toContain('\\');
    });

    // An absolute path or it is not a pointer — the shell's cwd is not the governed root and cannot be
    // assumed, which is why L1's messages name <root> explicitly rather than saying "cd first".
    it('keeps the path absolute, and starts on its own line so the house report shape holds', () => {
        const pointer = branchStateMatrixPointer('/repo/.webpieces/instruct-ai/webpieces.branch-state-matrix.md', '5');
        expect(pointer.startsWith('\n')).toBe(true);
        expect(pointer).toContain(' /repo/');
    });
});

/**
 * `cure=` — the other half of `row=`. Derived from the row, never passed in, so the logged cure is by
 * construction the literal the doc prints. See matrix-cures.ts for why a GuardDecision field would
 * have been two spellings of one thing.
 */
describe('cure= is looked up from the matrix, not authored twice', () => {
    it('logs the same literal the doc prints, for every blocking L2 row', () => {
        for (const row of L2_ROWS) {
            if (row.action.kind !== 'block') continue;
            expect(cureForMatrix('L2', String(row.num)), `row ${row.num}`).toBe(row.cure.replace(/`/g, ''));
        }
    });

    it('logs `-` for an allowing row, an unknown row, and a layer this module does not own', () => {
        expect(cureForMatrix('L2', '10')).toBe(NO_CURE);
        expect(cureForMatrix('L2', '-')).toBe(NO_CURE);
        expect(cureForMatrix('L2', '999')).toBe(NO_CURE);
        expect(cureForMatrix('L0', '3')).toBe(NO_CURE);
    });

    // Read through grep, not through a markdown renderer — a cure you cannot grep without escaping
    // fence characters is a cure the trail cannot be searched by.
    it('strips the doc backticks so the field is greppable', () => {
        expect(cureForMatrix('L2', '5')).toBe('git checkout -b <new> origin/main');
        expect(cureForMatrix('L2', '5')).not.toContain('`');
    });

    /*
     * ONE SPELLING FOR "make local `main` current", and it is the one CLAUDE.md names.
     *
     * Fleet-wide this rule emitted FOUR refresh-main cures across 238 prescriptions and the sanctioned
     * one appeared in 6 of them — so the guard prescribed the hand-rolled form
     * `.claude/rules/finishing-a-feature.md` explicitly
     * forbids 231 times out of 238, and agents caught between the two authorities improvised hybrids of
     * both (docs/audit/2026-08-24-mon-wed.md, section 3). `cure=` is looked up from the row, so pinning
     * the row's literal here pins what the log carries and what the doc prints at the same time.
     *
     * The BRANCH-OFF cure is a DIFFERENT intent and stays: refreshing `main` in place and cutting a new
     * branch off `origin/main` are different moves with different tree-state requirements. Row 5's cure
     * (asserted above) is untouched for exactly that reason.
     */
    it('prescribes `pnpm wp-sync-main` on every row that refreshes main', () => {
        expect(cureForMatrix('L2', '2')).toBe('pnpm wp-sync-main');
        expect(cureForMatrix('L2', '6')).toBe('pnpm wp-sync-main, or git checkout -b <new> origin/main');
        expect(cureForMatrix('L2', '13')).toBe('pnpm wp-sync-main && <your command>');
    });

    it('emits none of the retired refresh-main spellings, on any row or use case', () => {
        const retired = ['git pull origin main', 'git checkout main && git pull origin main', 'git pull --ff-only origin main'];
        for (const row of L2_ROWS) {
            for (const spelling of retired) {
                expect(row.cure, `row ${row.num}`).not.toContain(spelling);
                for (const useCase of row.useCases) {
                    expect(useCase.fix, `use case ${useCase.num}`).not.toContain(spelling);
                }
            }
        }
    });

    it('resolves a cure for every reason the guards can log on a blocking row', () => {
        for (const row of L2_ROWS) {
            if (row.action.kind !== 'block') continue;
            expect(cureForMatrix('L2', String(row.num)), `row ${row.num} has no loggable cure`).not.toBe(NO_CURE);
        }
    });
});

/**
 * THE USE CASES, and the join that keeps them honest.
 *
 * A use-case table is worth exactly as much as its worst-maintained row, so the enforcement here is not
 * "does it render" but "does each case's own `reason` string, pushed back through the SAME matcher the
 * guards stamp `row=` with, land on the row the case is filed under". That is the loop the decision log
 * opens: `row=` in the trail → this table on the page → one matcher between them.
 */
describe('L2 use cases', () => {
    it('numbers every case uniquely and contiguously from 1 — numbers are cited, so they are identity', () => {
        const numbers = allL2UseCases().map((useCase: L2UseCase): number => useCase.num);
        expect(new Set(numbers).size, 'duplicate use-case number').toBe(numbers.length);
        expect([...numbers].sort((a: number, b: number): number => a - b))
            .toEqual(Array.from({ length: numbers.length }, (_unused: unknown, i: number): number => i + 1));
    });

    it('files each case under the row its OWN logged reason resolves to', () => {
        const wrong: string[] = [];
        for (const row of L2_ROWS) {
            for (const useCase of row.useCases) {
                if (useCase.reason === NO_ROW_EXIT) continue;
                const resolved = l2RowForReason(useCase.reason);
                if (resolved !== row.num) wrong.push(`case ${useCase.num}: reason resolves to row ${String(resolved)}, filed under ${row.num}`);
            }
        }
        expect(wrong, 'a use case whose reason does not match its row misinforms every reader of the doc').toEqual([]);
    });

    /*
     * NO_ROW_EXIT opts a case out of the join above, so it is the one thing here that could quietly
     * hollow the enforcement out. Pinned to the exact cases that may use it: adding a third is a
     * deliberate edit to this list, not a sixth argument nobody reviews.
     */
    it('lets only the L4-owned merge-in-progress case skip the reason join', () => {
        const unenforced = allL2UseCases()
            .filter((useCase: L2UseCase): boolean => useCase.reason === NO_ROW_EXIT)
            .map((useCase: L2UseCase): number => useCase.num);
        expect(unenforced, 'NO_ROW_EXIT is for states another layer owns, not for cases nobody checked').toEqual([5]);
    });

    it('gives every case a literal Fix, or says None — never "see the docs"', () => {
        for (const useCase of allL2UseCases()) {
            expect(useCase.fix.length, `case ${useCase.num}`).toBeGreaterThan(0);
            expect(useCase.fix, `case ${useCase.num}`).not.toContain('see the docs');
        }
    });

    // NOTE: "every row has at least one use case" is NOT asserted here. It is the TYPE — `useCases` is a
    // non-empty tuple, so an empty row does not compile. A runtime assertion standing in for a type that
    // could express the invariant is the shape `.claude/rules/no-backwards-compat.md` rejects.

    it('renders every case into the doc, verbatim', () => {
        const doc = renderL2Doc();
        expect(doc).toContain('## L2 use cases');
        for (const useCase of allL2UseCases()) {
            expect(doc, `case ${useCase.num} symptom`).toContain(useCase.symptom);
            expect(doc, `case ${useCase.num} fix`).toContain(useCase.fix);
        }
    });

    /*
     * The NOT_DONE rows are the ones a reader is most likely to misread as live behaviour, so each gap
     * must have a use case on its row showing what actually happens today. NOT_DONE is empty right now,
     * so this asserts nothing about any row — it is armed for the next divergence. (Case 10, the
     * `npx expo install`-on-main write, was that instance while row 5's Bash half was a gap; it now
     * lives on row 6, the row that judges Bash on `main`.)
     */
    it('gives every Not-done row a use case on that row', () => {
        for (const entry of NOT_DONE) {
            const row = L2_ROWS.find((r: L2Row): boolean => r.num === entry.row);
            expect(row?.useCases.length, `not-done row ${entry.row} has no illustrating use case`).toBeGreaterThan(0);
        }
    });
});

/**
 * The doc IS the array. Locked byte-identical the same way guards/L1-location.md is locked to
 * renderL1Doc() — a doc that merely describes the table drifts from it within one release, and this
 * particular doc carried a written warning that it was drifting.
 */
describe('guards/L2-branch-state.md is generated from the rows', () => {
    it('matches renderL2Doc() byte for byte', () => {
        expect(fs.readFileSync(L2_DOC, 'utf8'), 'run `pnpm guards:generate` to regenerate the doc').toBe(renderL2Doc());
    });

    it('renders every row, with its tools, state and cure', () => {
        const doc = renderL2Doc();
        for (const row of L2_ROWS) {
            expect(doc, `row ${row.num} tools`).toContain(`| ${row.num} | \`${row.toolCell()}\` |`);
            expect(doc, `row ${row.num} state`).toContain(row.state);
            expect(doc, `row ${row.num} cure`).toContain(row.cure);
        }
    });

    it('renders the Not done gaps, so a row the code cannot honour is never shown as if it were live', () => {
        const doc = renderL2Doc();
        expect(doc).toContain('## Not done — rows the guards do not yet honour');
        for (const entry of NOT_DONE) {
            expect(doc, `not-done row ${entry.row}`).toContain(entry.gap);
            expect(doc, `not-done row ${entry.row} why`).toContain(entry.why);
        }
    });

    it('names the ONE config key, and none of the four retired ones, as the switch', () => {
        const doc = renderL2Doc();
        expect(doc).toContain('**Config key: `branch-state-guard`.**');
        // The four class names still appear — they are the operator identity and the code anchors —
        // so this asserts the doc never presents one of them as a thing you configure.
        for (const retired of ['read-stale-guard', 'merged-branch-bash-guard', 'stale-main-bash-guard', 'feature-branch-guard']) {
            expect(doc, retired).not.toContain(`**Config key: \`${retired}\``);
            expect(doc, retired).not.toContain(`hookGuards → ${retired}`);
        }
    });
});
