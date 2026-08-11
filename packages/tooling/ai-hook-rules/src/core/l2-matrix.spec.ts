import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect } from 'vitest';

import { renderL2Doc } from './l2-doc';
import {
    L2Row, L2Tool, L2_ROWS, L2_FAIL_OPEN_ROW, NOT_DONE, l2RowForReason, l2MappedReasons,
} from './l2-rows';
import { matrixL2Row, MATRIX_L2_UNROWED } from './decision-log';

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
    it('has eleven rows with unique numbers, in first-match order', () => {
        expect(L2_ROWS).toHaveLength(11);
        // The design's 1-5, then the cache divider, then 6-10. The divider is numbered 11 and PRINTED
        // in position because row numbers are identity: they are logged as `row=` and cited in the doc,
        // so renumbering 6-10 to slot it in would silently re-point every reference.
        expect(L2_ROWS.map((r: L2Row): number => r.num)).toEqual([1, 2, 3, 4, 5, 11, 6, 7, 8, 9, 10]);
        expect(new Set(L2_ROWS.map((r: L2Row): number => r.num)).size).toBe(11);
    });

    it('puts the on-main block ABOVE the cache divider — the most load-bearing order in the table', () => {
        const onMain = L2_ROWS.findIndex((r: L2Row): boolean => r.num === 5);
        const divider = L2_ROWS.findIndex((r: L2Row): boolean => r.num === L2_FAIL_OPEN_ROW);
        expect(onMain).toBeLessThan(divider);
    });

    it('judges `R` separately from `B`/`E` in exactly one place — rows 6/7 on main', () => {
        const readOnlyRows = L2_ROWS
            .filter((r: L2Row): boolean => r.tools.length === 1 && r.tools[0] === 'R')
            .map((r: L2Row): number => r.num);
        expect(readOnlyRows).toEqual([6, 7]);
    });

    it('gives every blocking row a LITERAL cure, and every allowing row none', () => {
        for (const row of L2_ROWS) {
            const blocking = row.action.kind === 'block';
            expect(blocking, `row ${row.num}`).toBe([2, 5, 6, 8, 9].includes(row.num));
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
