import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect } from 'vitest';

import { isAllowed } from '../bin/shim';
import { AgentIdentity, CoordinatorWorktreeGuard } from './coordinator-worktree';
import { EffectiveTree, atRoot } from './effective-tree';
import { renderL1Doc } from './l1-doc';
import {
    L1Classification, L1Kind, L1Row, L1UseCase, L1_ROWS, L1_UNROWED_USE_CASES,
    allL1UseCases, firstMatchingL1Row,
} from './l1-rows';

// The generated doc, and the runner that must keep saying what the rows claim it says.
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');
const L1_DOC = path.join(REPO_ROOT, 'guards', 'L1-location.md');
const RUNNER_SRC = fs.readFileSync(path.join(__dirname, 'runner.ts'), 'utf8');

const KINDS: readonly L1Kind[] = ['f', 'o', 'p', 'w'];
const BOOLS: readonly boolean[] = [false, true];

/** Every point in the five-dimensional space the matrix classifies over — 4 × 2 × 2 × 2 × 2 = 64. */
function everyClassification(): readonly L1Classification[] {
    const all: L1Classification[] = [];
    for (const kind of KINDS) {
        for (const coordinator of BOOLS) {
            for (const readOnly of BOOLS) {
                for (const git of BOOLS) {
                    for (const at of BOOLS) all.push(new L1Classification(kind, coordinator, readOnly, git, at));
                }
            }
        }
    }
    return all;
}

function label(c: L1Classification): string {
    return `K=${c.kind} A=${c.coordinator ? 'c' : 's'} R=${c.readOnly ? 'y' : 'n'} G=${c.git ? 'y' : 'n'} P=${c.atRoot ? 'root' : 'sub'}`;
}

/**
 * TOTALITY — the matrix has no hole and no ambiguity about the ANSWER.
 *
 * "Exactly one row" is asserted as the doc states it: first match wins. The overlap that produces is
 * not a defect and is pinned separately below, because it is the doc's own sentence — "row 3 is the ONE
 * place `p` and `w` separate" — turned into a test.
 */
describe('L1 matrix — every classification lands on exactly one verdict', () => {
    it('has six rows with unique numbers, in doc order', () => {
        expect(L1_ROWS).toHaveLength(6);
        expect(L1_ROWS.map((r: L1Row): number => r.num)).toEqual([1, 2, 3, 4, 5, 6]);
    });

    it('answers all 64 classifications — no classification falls through the table', () => {
        const all = everyClassification();
        expect(all).toHaveLength(64);
        for (const c of all) {
            const row = firstMatchingL1Row(c);
            expect(L1_ROWS, label(c)).toContain(row);
        }
    });

    it('makes every row reachable as a first match — no row is dead', () => {
        const reached = new Set(everyClassification().map((c: L1Classification): number => firstMatchingL1Row(c).num));
        expect([...reached].sort((a: number, b: number): number => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
    });

    // The ONLY overlap in the table, and it is the one the doc calls out by name. Pinned so that a new
    // row whose cells accidentally overlap an existing one shows up here rather than as a silent
    // reordering hazard.
    it('overlaps on exactly one shape: a coordinator, in a worktree, not inspecting (row 3 over rows 4/5/6)', () => {
        for (const c of everyClassification()) {
            const matches = L1_ROWS.filter((r: L1Row): boolean => r.matches(c));
            const isRow3Shape = c.kind === 'w' && c.coordinator && !c.readOnly;
            expect(matches.length, label(c)).toBe(isRow3Shape ? 2 : 1);
            if (isRow3Shape) expect(matches[0].num, label(c)).toBe(3);
        }
    });

    it('blocks on rows 3 and 5 only, and only those rows carry a cure and a blockId', () => {
        for (const row of L1_ROWS) {
            const blocking = row.action.kind === 'block';
            expect(blocking, `row ${row.num}`).toBe(row.num === 3 || row.num === 5);
            expect(row.cure !== null, `row ${row.num} cure`).toBe(blocking);
            expect(row.blockId !== null, `row ${row.num} blockId`).toBe(blocking);
        }
    });
});

/**
 * NO SHADOWED ROW — every row is load-bearing, witnessed by its own first use case.
 *
 * L0's version asserts "matched by its own body and by NO other", because its allowlist entries are
 * disjoint patterns. L1's table is ORDERED and its rows deliberately overlap (see above), so the
 * equivalent property here is the two-part one: the witness resolves to this row, and NO EARLIER row
 * matches it. A row that failed the second half would be unreachable — deletable while looking alive.
 */
describe('L1 rows — each row is witnessed by its own first use case', () => {
    for (const row of L1_ROWS.filter((r: L1Row): boolean => r.useCases.length > 0)) {
        it(`row ${row.num} is the first match for use case ${row.useCases[0].num}`, () => {
            const witness = row.useCases[0].classification;
            expect(witness, `use case ${row.useCases[0].num} needs a classification`).not.toBeNull();
            if (witness === null) return;
            expect(firstMatchingL1Row(witness).num).toBe(row.num);
            const earlier = L1_ROWS.slice(0, L1_ROWS.indexOf(row));
            for (const before of earlier) {
                expect(before.matches(witness), `row ${row.num} is shadowed by row ${before.num}`).toBe(false);
            }
        });
    }

    // Row 2 is the ONE row with no use case, because `o` is not reachable in production yet (see the
    // "Not done" section and L1Classification.forEnforcement). Pinned as an exact list so a NEW row
    // added without a witness fails here instead of silently going untested.
    it('has exactly one witnessless row — row 2, the not-yet-consumed `o`', () => {
        const witnessless = L1_ROWS.filter((r: L1Row): boolean => r.useCases.length === 0);
        expect(witnessless.map((r: L1Row): number => r.num)).toEqual([2]);
    });

    it('classifies every rowed use case onto the row that owns it', () => {
        for (const row of L1_ROWS) {
            for (const useCase of row.useCases) {
                expect(useCase.classification, `use case ${useCase.num}`).not.toBeNull();
                if (useCase.classification === null) continue;
                expect(firstMatchingL1Row(useCase.classification).num, `use case ${useCase.num}`).toBe(row.num);
            }
        }
    });

    // The filter and the L0 allowlist are not rows, so their use cases carry no classification — but
    // they are still L1 use cases and still numbered in the one table.
    it('keeps the unrowed use cases classification-free, and the numbering contiguous 1..15', () => {
        for (const useCase of L1_UNROWED_USE_CASES) expect(useCase.classification, `use case ${useCase.num}`).toBeNull();
        expect(allL1UseCases().map((u: L1UseCase): number => u.num))
            .toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    });
});

/**
 * CURE REACHABILITY — a blocked reader must be able to act on what the row prescribes.
 *
 * Scoped to the cures that ARE commands. Row 3's cure is an instruction ("spawn a subagent bound to the
 * worktree"): no allowlist can accept it and no reclassification can model it, so it is asserted on the
 * deny text instead. Row 5's cure is a command, and the property that matters is stronger than "the
 * allowlist accepts it" — applying it must actually stop the row from matching, or the guard prescribes
 * a command that gets the same block again, which is the deadlock shape CLAUDE.md records three times.
 */
describe('L1 cures — the runnable ones clear the block they are prescribed for', () => {
    it('row 5: `cd <root> && <original>` moves P from `sub` to `root`, landing on row 6 (→ L2)', () => {
        const blocked = new L1Classification('p', false, false, true, false);
        expect(firstMatchingL1Row(blocked).num).toBe(5);
        const cured = new L1Classification('p', false, false, true, true);
        expect(firstMatchingL1Row(cured).num).toBe(6);
        expect(firstMatchingL1Row(cured).blockId).toBeNull();
    });

    it('row 5: the remedy the runner actually emits is accepted by the L0 allowlist', () => {
        // atRoot() is what gitFromSubdirBlock prints. For an L0-listed command it must survive the
        // outermost layer too, or the cure is untypable while a tooling fault is up.
        expect(isAllowed('Bash', atRoot('/repo', 'git status'), '')).not.toBeNull();
    });

    // Use case 11 states this out loud: `cd <root> && git push` is NOT allowed onward — it earns the
    // push guard's real answer, one turn later, by design. Pinned so nobody "fixes" the L0 allowlist to
    // make row 5's cure universally passable.
    it('does not promise the cure passes the LATER guards — `git push` is still not L0-allowed', () => {
        expect(isAllowed('Bash', atRoot('/repo', 'git push'), '')).toBeNull();
    });

    it('row 3: the cure is prose, and the guard names it verbatim in the deny', () => {
        const row = L1_ROWS[2];
        expect(row.cure?.runnable).toBe(false);
        const tree = new EffectiveTree('/repo', '/wt', '/wt', '/repo', 'worktree');
        const report = new CoordinatorWorktreeGuard().block('pnpm build', tree, new AgentIdentity('', ''));
        expect(report).not.toBeNull();
        expect(report).toContain(row.cure?.denyMention);
    });

    it('row 5: the deny text the row names is the one runner.ts emits', () => {
        expect(RUNNER_SRC).toContain(L1_ROWS[4].cure?.denyMention);
    });
});

/**
 * The row lookup and the two report builders must agree. runner.l1LocationBlock dispatches on the ROW,
 * but each builder still re-checks its own predicate — so if the two ever disagreed, a row could match
 * while the builder it names returns null and the block silently disappears.
 */
describe('L1 rows agree with the predicates the guards enforce', () => {
    it('row 3 matches exactly when CoordinatorWorktreeGuard blocks', () => {
        const guard = new CoordinatorWorktreeGuard();
        const coordinator = new AgentIdentity('', '');
        const subagent = new AgentIdentity('a1', 'general-purpose');
        const cases: readonly [string, string, AgentIdentity][] = [
            ['pnpm build', 'worktree', coordinator],
            ['ls -la', 'worktree', coordinator],
            ['pnpm build', 'worktree', subagent],
            ['pnpm build', 'primary', coordinator],
        ];
        for (const [command, kind, agent] of cases) {
            const tree = new EffectiveTree('/repo', '/wt', '/wt', '/repo', kind === 'worktree' ? 'worktree' : 'primary');
            const blocked = guard.block(command, tree, agent) !== null;
            const classification = L1Classification.forEnforcement(
                tree.kind, agent.coordinator, command === 'ls -la', false, false,
            );
            expect(firstMatchingL1Row(classification).blockId === 'coordinator-in-worktree', `${command} / ${kind}`)
                .toBe(blocked);
        }
    });

    /**
     * TreeKind `'outside'` classifies as `p`, NOT as row 2's `o`. That is today's behaviour, not an
     * aspiration: nothing branches on `'outside'`, so a `git` command from /tmp is force-to-root
     * blocked. Row 2 documents where this is going; exempting `o` alone would open a `cd /tmp &&`
     * bypass of every L2 guard, so it ships with target-based jurisdiction or not at all.
     */
    it('classifies `outside` as `p` for enforcement, keeping force-to-root live outside any repo', () => {
        const outside = L1Classification.forEnforcement('outside', false, false, true, false);
        expect(outside.kind).toBe('p');
        expect(firstMatchingL1Row(outside).num).toBe(5);
        // …while the matrix still knows what `o` SHOULD do.
        expect(firstMatchingL1Row(new L1Classification('o', false, false, true, false)).num).toBe(2);
    });

    it('maps the other three tree kinds straight through', () => {
        expect(L1Classification.forEnforcement('foreign', false, false, false, false).kind).toBe('f');
        expect(L1Classification.forEnforcement('worktree', false, false, false, false).kind).toBe('w');
        expect(L1Classification.forEnforcement('primary', false, false, false, false).kind).toBe('p');
    });
});

/**
 * The doc IS the array. Locked byte-identical the same way webpieces.guard-matrix.md is locked to
 * renderGuardMatrixDoc() — a doc that merely describes the table drifts from it within one release.
 *
 * This spec, not the runtime hook, is the gate: `.webpieces/instruct-ai/` carries the PUBLISHED copy
 * and is a release behind, while vitest resolves @webpieces/* to LOCAL source.
 */
describe('guards/L1-location.md is generated from the rows the guard consults', () => {
    it('matches renderL1Doc() byte for byte', () => {
        expect(fs.readFileSync(L1_DOC, 'utf8'), 'run `pnpm guards:generate` to regenerate the doc').toBe(renderL1Doc());
    });

    it('renders every row and every use case', () => {
        const doc = renderL1Doc();
        for (const row of L1_ROWS) {
            expect(doc, `row ${row.num} act`).toContain(`| ${row.num} | ${row.k === '-' ? '-' : `\`${row.k}\``} |`);
            if (row.why !== '') expect(doc, `row ${row.num} why`).toContain(row.why);
        }
        for (const useCase of allL1UseCases()) {
            expect(doc, `use case ${useCase.num} symptom`).toContain(useCase.symptom);
            expect(doc, `use case ${useCase.num} fix`).toContain(useCase.fix);
        }
    });

    // The prose sections are literal lines in the renderer, and this is the one that must never be
    // summarised away: three code comments point a reader at it.
    it('keeps the prose the code points at — the "Not done" section and the code anchors', () => {
        const doc = renderL1Doc();
        expect(doc).toContain('## Not done — `o` is not exempt yet');
        expect(doc).toContain('Ship the two together, or neither.');
        expect(doc).toContain('## Code anchors');
    });
});
