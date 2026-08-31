import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, beforeAll } from 'vitest';

import { isAllowed } from '../bin/shim';
import { migrate } from '../bin/setup-config';
import { BlockedResult } from './types';
import { VersionSyncGuard } from './version-sync';
import { EffectiveTree, EffectiveTreeResolver, atRoot } from './effective-tree';
import { MissingDirectoryGuard } from './missing-directory';
import { ReadOnlyInspectionScan } from './read-only-inspection';
import { isGitOrGhCommand, runBash } from './runner';
import { loadTemplate } from '@webpieces/rules-config';

import { renderL1Doc } from './l1-doc';
import { LOCATION_MATRIX_DOC, locationMatrixPointer } from './l1-matrix-doc';
import {
    L1Classification, L1Kind, L1Row, L1UseCase, L1_ROWS, L1_PRESTAGE_ROW, L1_UNROWED_USE_CASES,
    allL1UseCases, firstMatchingL1Row,
} from './l1-rows';

// The generated doc, and the runner that must keep saying what the rows claim it says.
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');
const L1_DOC = path.join(REPO_ROOT, 'guards', 'L1-location.md');
// Row 5's deny text lives with its guard, not in the runner — see force-to-root.ts.
const FORCE_TO_ROOT_SRC = fs.readFileSync(path.join(__dirname, 'force-to-root.ts'), 'utf8');

const KINDS: readonly L1Kind[] = ['f', 'm', 'o', 'p', 'w'];
const BOOLS: readonly boolean[] = [false, true];

/** Every point in the five-dimensional space the matrix classifies over — 5 × 2 × 2 × 2 × 2 = 80. */
function everyClassification(): readonly L1Classification[] {
    const all: L1Classification[] = [];
    for (const kind of KINDS) {
        for (const versionsSkewed of BOOLS) {
            for (const readOnly of BOOLS) {
                for (const git of BOOLS) {
                    for (const at of BOOLS) all.push(new L1Classification(kind, versionsSkewed, readOnly, git, at));
                }
            }
        }
    }
    return all;
}

function label(c: L1Classification): string {
    return `K=${c.kind} V=${c.versionsSkewed ? 'n' : 'y'} R=${c.readOnly ? 'y' : 'n'} G=${c.git ? 'y' : 'n'} P=${c.atRoot ? 'root' : 'sub'}`;
}

/**
 * TOTALITY — the matrix has no hole and no ambiguity about the ANSWER.
 *
 * "Exactly one row" is asserted as the doc states it: first match wins. The overlap that produces is
 * not a defect and is pinned separately below, because it is the doc's own sentence — "row 3 is the ONE
 * place `p` and `w` separate" — turned into a test.
 */
/**
 * A real main tree + linked-worktree pair whose pnpm-workspace.yaml catalogs disagree (or agree, when a
 * version is passed). REAL FILES on purpose: VersionSyncGuard reads manifests off disk, so a fabricated
 * path would silently read nothing, come back "in sync", and make every assertion here vacuous.
 */
function stageSkew(worktreeVersion = '0.4.612'): { main: string; worktree: string } {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-skew-'));
    const main = path.join(base, 'main');
    const worktree = path.join(base, 'wt');
    for (const dir of [main, worktree]) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(main, 'pnpm-workspace.yaml'), "catalog:\n  '@webpieces/nx-webpieces-rules': 0.4.616\n");
    fs.writeFileSync(path.join(worktree, 'pnpm-workspace.yaml'), `catalog:\n  '@webpieces/nx-webpieces-rules': ${worktreeVersion}\n`);
    return { main, worktree };
}

describe('L1 matrix — every classification lands on exactly one verdict', () => {
    it('has seven rows with unique numbers, in doc order', () => {
        expect(L1_ROWS).toHaveLength(7);
        // Row 3 is RETIRED (coordinator-in-worktree) and its number is never reused — row numbers are
        // identity: they are printed in denies, logged as `row=`, and cited in guards/L1-location.md.
        expect(L1_ROWS.map((r: L1Row): number => r.num)).toEqual([1, 2, 8, 4, 5, 6, 7]);
    });

    it('answers all 80 classifications — no classification falls through the table', () => {
        const all = everyClassification();
        expect(all).toHaveLength(80);
        for (const c of all) {
            const row = firstMatchingL1Row(c);
            expect(L1_ROWS, label(c)).toContain(row);
        }
    });

    it('makes every row reachable as a first match — no row is dead', () => {
        const reached = new Set(everyClassification().map((c: L1Classification): number => firstMatchingL1Row(c).num));
        expect([...reached].sort((a: number, b: number): number => a - b)).toEqual([1, 2, 4, 5, 6, 7, 8]);
    });

    // The ONLY overlap in the table, and it is the one the doc calls out by name. Pinned so that a new
    // row whose cells accidentally overlap an existing one shows up here rather than as a silent
    // reordering hazard.
    it('overlaps on exactly one shape: a SKEWED worktree, not inspecting (row 8 over rows 4/5/6)', () => {
        for (const c of everyClassification()) {
            const matches = L1_ROWS.filter((r: L1Row): boolean => r.matches(c));
            const isRow8Shape = c.kind === 'w' && c.versionsSkewed && !c.readOnly;
            expect(matches.length, label(c)).toBe(isRow8Shape ? 2 : 1);
            if (isRow8Shape) expect(matches[0].num, label(c)).toBe(8);
        }
    });

    it('blocks on rows 8, 5 and 7 only, and only those rows carry a cure and a blockId', () => {
        for (const row of L1_ROWS) {
            const blocking = row.action.kind === 'block';
            expect(blocking, `row ${row.num}`).toBe(row.num === 8 || row.num === 5 || row.num === 7);
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
    it('keeps the unrowed use cases classification-free, and the numbering contiguous 1..20', () => {
        for (const useCase of L1_UNROWED_USE_CASES) expect(useCase.classification, `use case ${useCase.num}`).toBeNull();
        expect(allL1UseCases().map((u: L1UseCase): number => u.num))
            .toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
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

    it('row 8: the cure is prose, and the guard names it verbatim in the deny', () => {
        const row = L1_ROWS[2];
        expect(row.num).toBe(8);
        expect(row.cure?.runnable).toBe(false);
        const skew = stageSkew();
        const tree = new EffectiveTree(
            skew.main, skew.worktree, skew.worktree, skew.main, skew.main, 'worktree');
        const report = new VersionSyncGuard().block('pnpm build', tree);
        expect(report).not.toBeNull();
        expect(report).toContain(row.cure?.denyMention);
    });

    /**
     * MECHANICAL, because a comment is not enforcement. `remedyAtRoot` is a strict superset of
     * `atRoot`: identical when the command has no leading `cd`, and correct where `atRoot` is
     * known-wrong (it prefixes a second `cd`, so the remedy re-fires the block that printed it —
     * the compounding deadlock this layer shipped). `atRoot` stays because it is the lower-level
     * QUOTING formatter with legitimate call sites, and the strip needs CommandScanner, which lives a
     * package above rules-config — so the dangerous spelling is the shorter and more reachable one.
     * This makes "an L1 block builder never calls bare atRoot" fail the build instead of a review.
     */
    it('no L1 block builder formats its remedy with bare atRoot() — only remedyAtRoot()', () => {
        for (const file of ['force-to-root.ts', 'missing-directory.ts', 'version-sync.ts']) {
            // Comment lines are dropped first — these docblocks NAME `atRoot()` to explain the rule,
            // and a check that forbade saying the word would just get the explanation deleted.
            const code = fs.readFileSync(path.join(__dirname, file), 'utf8')
                .split('\n')
                .filter((line: string): boolean => !/^\s*(?:\/\/|\*|\/\*)/.test(line))
                .join('\n');
            expect(code, `${file} must not call atRoot() directly`).not.toMatch(/\batRoot\(/);
        }
    });

    it('row 5: the deny text the row names is the one runner.ts emits', () => {
        expect(FORCE_TO_ROOT_SRC).toContain(L1_ROWS[4].cure?.denyMention);
    });
});

/**
 * The row lookup and the two report builders must agree. runner.l1LocationBlock dispatches on the ROW,
 * but each builder still re-checks its own predicate — so if the two ever disagreed, a row could match
 * while the builder it names returns null and the block silently disappears.
 */
describe('L1 rows agree with the predicates the guards enforce', () => {
    it('row 8 matches exactly when VersionSyncGuard blocks', () => {
        const guard = new VersionSyncGuard();
        const skew = stageSkew();
        const same = stageSkew('0.4.616');
        const cases: readonly [string, string, { main: string; worktree: string }][] = [
            ['pnpm build', 'worktree', skew],   // skewed worktree, real work -> BLOCK
            ['ls -la', 'worktree', skew],       // skewed worktree, inspection -> allow
            ['pnpm build', 'worktree', same],   // aligned worktree -> allow
            ['pnpm build', 'primary', skew],    // main tree is never this guard's business
            // The RESIDENT agent: cwd IS the worktree, so the worktree's own tracked config governs it.
            // K is still `w` (git's answer), and the comparison is still against the main clone.
            ['pnpm build', 'resident', skew],
            ['ls -la', 'resident', skew],
        ];
        for (const [command, kind, dirs] of cases) {
            const governed = kind === 'resident' ? dirs.worktree : dirs.main;
            const tree = new EffectiveTree(
                dirs.main, dirs.worktree, dirs.worktree, governed, dirs.main,
                kind === 'primary' ? 'primary' : 'worktree',
            );
            const blocked = guard.block(command, tree) !== null;
            const classification = L1Classification.forEnforcement(
                tree.kind, guard.skewed(tree), command === 'ls -la', false, false,
            );
            expect(firstMatchingL1Row(classification).blockId === 'trinary-version-skew', `${command} / ${kind}`)
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

    it('maps the other tree kinds straight through', () => {
        expect(L1Classification.forEnforcement('foreign', false, false, false, false).kind).toBe('f');
        expect(L1Classification.forEnforcement('worktree', false, false, false, false).kind).toBe('w');
        expect(L1Classification.forEnforcement('primary', false, false, false, false).kind).toBe('p');
        expect(L1Classification.forEnforcement('missing', false, false, false, false).kind).toBe('m');
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

    /**
     * THE DELIVERED COPY. `guards/` is a path in webpieces' own repo; a consumer repo has no such
     * directory, so for 1,457 logged `layer=L1 row=<n>` decisions across nine repos there was nowhere
     * to look a row up. `webpieces.location-matrix.md` is that lookup, and it is the SAME bytes.
     */
    it('is delivered as webpieces.location-matrix.md, byte for byte', () => {
        expect(loadTemplate(LOCATION_MATRIX_DOC), 'run `pnpm guards:generate`').toBe(renderL1Doc());
        expect(loadTemplate(LOCATION_MATRIX_DOC)).toBe(fs.readFileSync(L1_DOC, 'utf8'));
    });

    /**
     * EVERY ROW NUMBER L1 CAN EMIT HAS AN ENTRY. The audit's finding was not "the table is wrong", it
     * was "an agent told row 6 has nowhere to look it up" — so the assertion is about the DELIVERED
     * page and about the numbers that reach a LOG, which includes the pre-stage row 0 (it is not in
     * `L1_ROWS`, it is decided from command text before a tree is resolved, and it still logs `row=0`).
     */
    it('gives every row number L1 can log a row in the delivered matrix', () => {
        const delivered = loadTemplate(LOCATION_MATRIX_DOC);
        const emittable = [L1_PRESTAGE_ROW, ...L1_ROWS.map((row: L1Row): number => row.num)];
        for (const num of emittable) {
            expect(delivered, `row=${num} has no row in ${LOCATION_MATRIX_DOC}`).toContain(`\n| ${num} | `);
        }
    });

    /**
     * THE POINTER — the half that makes the delivered copy reachable at the moment of the deny.
     *
     * A doc that always exists still helps nobody if the deny does not name it: a blocked agent reads
     * the deny text and nothing else. L0 and L2 have named theirs for releases; L1 shipped the table
     * (PR #696) and not the pointer, which is the gap these assertions pin shut.
     */
    it('points the reader at the doc only when it was actually written', () => {
        expect(locationMatrixPointer('', '6')).toBe('');
        expect(locationMatrixPointer('/repo/.webpieces/instruct-ai/webpieces.location-matrix.md', '6'))
            .toContain('/repo/.webpieces/instruct-ai/webpieces.location-matrix.md');
    });

    // The row is the point: a bare "read this doc" is a page, a row number is the two lines that
    // explain this exact verdict — and it is the SAME number the L1 log line carries.
    it('names the row that judged the call, including the pre-stage row 0', () => {
        expect(locationMatrixPointer('/tmp/x.md', '6')).toContain('ROW 6');
        expect(locationMatrixPointer('/tmp/x.md', L1_PRESTAGE_ROW)).toContain(`ROW ${L1_PRESTAGE_ROW}`);
    });

    // Interpolated into a REASON="…" shell assignment and then printf'd into a JSON string, exactly as
    // L0's and L2's are: a quote or backslash corrupts the decision payload, not merely the prose.
    it('emits a JSON-safe pointer', () => {
        const pointer = locationMatrixPointer('/repo/.webpieces/instruct-ai/webpieces.location-matrix.md', '5');
        expect(pointer).not.toContain('"');
        expect(pointer).not.toContain('\\');
    });

    // An absolute path or it is not a pointer — the shell's cwd is not the governed root and cannot be
    // assumed, which is why L1's own messages name <root> explicitly rather than saying "cd first".
    it('keeps the path absolute, and starts on its own line so the house report shape holds', () => {
        const pointer = locationMatrixPointer('/repo/.webpieces/instruct-ai/webpieces.location-matrix.md', '5');
        expect(pointer.startsWith('\n')).toBe(true);
        expect(pointer).toContain(' /repo/');
    });

    it('tells a reader how a `row=` in the L1 log joins back to the table', () => {
        const doc = renderL1Doc();
        expect(doc).toContain('## How a log line joins to a row');
        expect(doc).toContain('.webpieces/logs/L1-location/<writer>.log');
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

/**
 * END TO END — the resolver's REAL output, driven through the matrix.
 *
 * THIS IS THE TEST THAT WAS MISSING, and its absence is why a guard bypass shipped. Every other
 * assertion in this file hand-constructs its input (`new EffectiveTree('/repo', '/wt', '/wt', '/repo',
 * '/repo', 'worktree')`), so the whole matrix passed while `classify()` never emitted `'worktree'` for the
 * only worktree layout the harness produces — it emitted `'foreign'`, which row 1 exempts. A matrix spec
 * that builds its own inputs can never catch an input bug. Do not "simplify" these back to literals.
 *
 * It happened a SECOND time for the same reason (2026-08-10): `classify()` answered `'primary'` whenever
 * the judged tree also owned the config — which is every worktree an agent LIVES in — so row 8 was
 * unreachable for exactly those agents. `rowForFrom()` below drives the resolver from the worktree's own
 * cwd, which is the input shape the hand-built cases could not express.
 */
describe('L1 end to end — a REAL linked worktree, resolved and then classified', () => {
    let primary: string;
    let agentTree: string;
    let nestedClone: string;

    function initRepo(dir: string): void {
        fs.mkdirSync(dir, { recursive: true });
        const git = (...args: string[]): void => { execFileSync('git', args, { cwd: dir, stdio: 'pipe' }); };
        git('init', '-b', 'main');
        git('config', 'core.hooksPath', '/dev/null');
        git('config', 'user.email', 'test@example.com');
        git('config', 'user.name', 'test');
        fs.writeFileSync(path.join(dir, 'f.txt'), 'x');
        git('add', '-A');
        git('commit', '-m', 'init');
    }

    beforeAll(() => {
        const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wp-l1-e2e-')));
        primary = path.join(home, 'primary');
        initRepo(primary);
        agentTree = path.join(primary, '.claude', 'worktrees', 'agent-e2e');
        execFileSync('git', ['worktree', 'add', agentTree, '-b', 'agent-e2e'], { cwd: primary, stdio: 'pipe' });
        nestedClone = path.join(primary, 'repositories', 'vendored');
        initRepo(nestedClone);
    });

    // The runner's own translation, reproduced so the chain under test is resolver → classification → row.
    function rowFor(command: string, versionsSkewed: boolean): number {
        return rowForFrom(primary, primary, command, versionsSkewed);
    }

    /**
     * The same chain for an agent that LIVES in the tree: cwd is the worktree, and `governedRoot` is the
     * worktree too, because a worktree carries its own tracked `webpieces.config.json`.
     */
    // eslint-disable-next-line @typescript-eslint/max-params -- cwd + governed root + the two rowFor inputs
    function rowForFrom(cwd: string, governedRoot: string, command: string, versionsSkewed: boolean): number {
        const tree = new EffectiveTreeResolver().resolve(command, cwd, governedRoot);
        return firstMatchingL1Row(L1Classification.forEnforcement(
            tree.kind,
            versionsSkewed,
            new ReadOnlyInspectionScan().isReadOnlyInspection(command),
            isGitOrGhCommand(command),
            path.resolve(tree.effectiveCwd) === path.resolve(tree.root),
        )).num;
    }

    it('an in-repo `.claude/worktrees/**` tree reaches ROW 8 when skewed, never row 1', () => {
        expect(rowFor(`cd ${agentTree} && pnpm build`, true)).toBe(8);
    });

    /**
     * THE MEASURED HOLE: the agent is INSIDE the worktree and the worktree governs itself. This used to
     * classify `p`, so row 8 (`w`) could not match and the skewed tree worked on unblocked.
     */
    it('an agent whose cwd IS the worktree reaches ROW 8 too — self-governance is not primacy', () => {
        expect(rowForFrom(agentTree, agentTree, 'pnpm build', true)).toBe(8);
        // …and it is still handed DOWN when the versions agree, exactly like the `cd`-in form.
        expect(rowForFrom(agentTree, agentTree, 'pnpm build', false)).toBe(4);
    });

    it('…and is handed DOWN for a subagent — governed, not exempt (row 1 would mean every guard off)', () => {
        expect(rowFor(`cd ${agentTree} && pnpm build`, false)).toBe(4);
        expect(rowFor(`cd ${agentTree} && git push`, false)).toBe(6);
    });

    it('a nested clone still lands on row 1 (`f`, exempt) — the no-regression half', () => {
        expect(rowFor(`cd ${nestedClone} && git push`, false)).toBe(1);
    });

    it('a genuine subdirectory of the primary still lands on row 5 (force-to-root)', () => {
        const sub = path.join(primary, 'packages', 'http');
        fs.mkdirSync(sub, { recursive: true });
        expect(rowFor(`cd ${sub} && git status`, false)).toBe(5);
    });

    it('a DELETED tree lands on row 7, not row 5 — "gone", not "a subdirectory"', () => {
        const dead = path.join(primary, '.claude', 'worktrees', 'agent-reaped');
        expect(fs.existsSync(dead)).toBe(false);
        expect(rowFor(`cd ${dead} && git fetch origin main`, false)).toBe(7);
    });

    it('row 7: the deny text the row names is the one MissingDirectoryGuard emits', () => {
        const dead = path.join(primary, '.claude', 'worktrees', 'agent-reaped');
        const command = `cd ${dead} && git fetch origin main`;
        const tree = new EffectiveTreeResolver().resolve(command, primary, primary);
        const report = new MissingDirectoryGuard().block(command, tree);
        expect(report).not.toBeNull();
        expect(report).toContain(L1_ROWS[6].cure?.denyMention);
    });
});

/**
 * ONE STORY ABOUT `git -C`, ACROSS EVERY SURFACE THAT NAMES IT.
 *
 * Four files talked about the same command and disagreed, which is the contradiction this describe pins
 * shut:
 *   • version-sync.ts PRESCRIBED `git -C <main tree> pull` as the FIRST cure for a version skew,
 *   • runner.ts RECOMMENDED `git -C <dir>` as the directory-flag idiom, with no boundary at all,
 *   • l1-rows.ts advertised `git -C <worktree> …` as ALWAYS permitted,
 *   • while shim-deny-reason.ts told subagents, correctly, that `git -C <main>` is REFUSED.
 * An agent that met the first three and then hit the fourth read the refusal as a fluke and retried.
 * Measured 2026-08-19: 25 firings of trinary-version-skew across one session, 13 of them in a single
 * subagent, every one of them on ordinary read-only work (grep, ls, find, git checkout -b).
 *
 * The settled story, which every message must now tell:
 *   `git -C <dir INSIDE your own tree>`  → fine, and runner.ts's idiom advice is correct there.
 *   `git -C <another tree>`              → refused to a subagent, and never the cure for a skew even
 *                                          for a human, because a bare `pull` does not name a branch.
 *
 * Scanning SOURCE rather than rendered output is deliberate: a prescription can hide in a template that
 * renders on only one branch of one guard, and that is exactly where the worst instance was hiding.
 */
describe('no surface prescribes cross-tree `git -C` as a cure', () => {
    // The three message-bearing modules. shim-deny-reason.ts is excluded ON PURPOSE — it names
    // `git -C <root>` in order to say it is REFUSED, which is the story being told, not a breach of it.
    const SITES = ['version-sync.ts', 'runner.ts', 'l1-rows.ts'] as const;

    const sourceOf = (site: string): string => fs.readFileSync(path.join(__dirname, site), 'utf8');

    /**
     * A PRESCRIPTION is `git -C` whose directory is INTERPOLATED — `${tree.mainRoot}`, `$ROOT`. That is
     * what makes it read as a runnable command aimed at a real other tree. A literal placeholder like
     * `git -C <dir>` is documentation of an idiom, and is judged by the boundary test below instead.
     */
    it('never interpolates a path into a `git -C` the reader is told to run', () => {
        for (const site of SITES) {
            const prescriptions = sourceOf(site)
                .split('\n')
                // Lines that RUN git from node are not messages to a reader; spawnSync takes an argv array.
                .filter((line: string) => !line.includes('spawnSync'))
                .filter((line: string) => /git -C \$\{|git -C \$[A-Z]/.test(line));
            expect(prescriptions, `${site} prescribes cross-tree git -C`).toEqual([]);
        }
    });

    /**
     * Wherever the literal idiom IS taught, the sentence that bounds it must be in the SAME message.
     *
     * "Taught" means a line the READER sees, so `//` and ` *` comment lines are skipped: version-sync.ts
     * names `git -C <dir> <sub>` in a comment explaining how its argv parser skips the flag, which
     * teaches nobody an idiom and needs no caveat.
     */
    it('bounds the `git -C <dir>` idiom to this tree wherever it is taught', () => {
        for (const site of SITES) {
            const source = sourceOf(site);
            const teaches = source
                .split('\n')
                .some((line: string) => line.includes('git -C <dir') && !/^\s*(\/\/|\*|\/\*)/.test(line));
            if (!teaches) continue;
            expect(source, `${site} teaches git -C without bounding it to this tree`).toContain('INSIDE this tree');
            expect(source, `${site} teaches git -C without naming the cross-tree refusal`).toMatch(/another tree/i);
        }
    });

    /** The skew guard's own report is the one that must be clean in BOTH of its branches. */
    it('leaves no `git -C <path>` command in either branch of the skew report', () => {
        const source = sourceOf('version-sync.ts');
        expect(source).not.toContain('`git -C ${tree.mainRoot}');
        expect(source).not.toContain('`git -C ${tree.root}');
    });
});

/**
 * THE DENY NAMES THE MATRIX — end to end, through the real runner.
 *
 * The delivered table (above) fixed the record; this fixes the experience. A blocked agent reads the
 * deny text and nothing else, so a table the deny does not name is indistinguishable from one that does
 * not exist. L0 and L2 have named theirs for releases; L1 — the layer emitting by far the most `row=` —
 * shipped the table and no pointer, and that is the regression these pin shut.
 *
 * Both branches of `l1LocationBlock` are driven: the row-0 PRE-STAGE (decided from command text before
 * a tree is resolved, and therefore the deny path most easily left out of a centralised pointer) and a
 * TREE-BASED row reached through `firstMatchingL1Row`.
 */
describe('an L1 deny names the L1 matrix, by absolute path and by row', () => {
    let outer: string;
    let matrixPath: string;

    // loadAndValidate demands a FULLY valid config, so it is built with the installer's own seeder
    // rather than hand-rolled — the same shape runner.spec.ts uses, and for the same reason.
    function writeGuardConfig(root: string): void {
        // webpieces-disable no-any-unknown -- opaque JSON config shape, only mutated by known keys here
        const config = migrate({}).config as Record<string, any>;
        config.hookGuards['branch-creation-guard'].autoReapMergedBranches = false;
        for (const name of Object.keys(config.hookGuards)) config.hookGuards[name].mode = 'OFF';
        config.excludePaths = [];
        fs.writeFileSync(path.join(root, 'webpieces.config.json'), JSON.stringify(config));
    }

    function initTempRepo(dir: string): void {
        fs.mkdirSync(dir, { recursive: true });
        const git = (...args: string[]): void => { execFileSync('git', args, { cwd: dir, stdio: 'pipe' }); };
        git('init', '-b', 'main');
        git('config', 'core.hooksPath', '/dev/null');   // never this machine's global hooks
        git('config', 'user.email', 'test@example.com');
        git('config', 'user.name', 'test');
        fs.writeFileSync(path.join(dir, 'f.txt'), 'x');
        git('add', '-A');
        git('commit', '-m', 'init');
    }

    beforeAll(() => {
        outer = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wp-l1ptr-')));
        initTempRepo(outer);
        writeGuardConfig(outer);
        matrixPath = path.join(outer, '.webpieces', 'instruct-ai', LOCATION_MATRIX_DOC);
    });

    it(`row ${L1_PRESTAGE_ROW} (the misplaced-\`cd\` pre-stage): absolute path + the row`, () => {
        const report = (runBash('ls && cd sub && pnpm build', outer, 'guards') as BlockedResult).report;
        expect(report).toContain('must come FIRST');
        expect(report).toContain(matrixPath);
        expect(report).toContain(`ROW ${L1_PRESTAGE_ROW}`);
    });

    it('row 5 (git from a subdirectory, force-to-root): absolute path + the row', () => {
        const sub = path.join(outer, 'packages', 'http');
        fs.mkdirSync(sub, { recursive: true });
        const report = (runBash(`cd ${sub} && git status`, outer, 'guards') as BlockedResult).report;
        expect(report).toContain(matrixPath);
        expect(report).toContain('ROW 5');
    });

    // Lazy: the doc is written on a BLOCK and nowhere else, so an agent that was never blocked never
    // pays for a file it will not read.
    it('writes the matrix only on a block', () => {
        const clean = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wp-l1ptr-ok-')));
        initTempRepo(clean);
        writeGuardConfig(clean);
        expect(runBash('pnpm build && pnpm test', clean, 'guards')).toBeNull();
        expect(fs.existsSync(path.join(clean, '.webpieces', 'instruct-ai', LOCATION_MATRIX_DOC))).toBe(false);
    });

    // The DELIVERED text, not merely the pure function: it is interpolated into a JSON decision
    // payload, where a quote corrupts the decision rather than merely the prose.
    it('adds nothing to the deny that could corrupt the JSON payload', () => {
        const report = (runBash('ls && cd sub && pnpm build', outer, 'guards') as BlockedResult).report;
        const pointer = report.slice(report.indexOf('The full L1 location matrix'));
        expect(pointer).not.toContain('"');
        expect(pointer).not.toContain('\\');
    });
});
