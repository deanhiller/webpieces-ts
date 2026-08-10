import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, beforeAll } from 'vitest';

import { isAllowed } from '../bin/shim';
import { VersionSyncGuard } from './version-sync';
import { EffectiveTree, EffectiveTreeResolver, atRoot } from './effective-tree';
import { MissingDirectoryGuard } from './missing-directory';
import { ReadOnlyInspectionScan } from './read-only-inspection';
import { isGitOrGhCommand } from './runner';
import { renderL1Doc } from './l1-doc';
import {
    L1Classification, L1Kind, L1Row, L1UseCase, L1_ROWS, L1_UNROWED_USE_CASES,
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
    it('keeps the unrowed use cases classification-free, and the numbering contiguous 1..19', () => {
        for (const useCase of L1_UNROWED_USE_CASES) expect(useCase.classification, `use case ${useCase.num}`).toBeNull();
        expect(allL1UseCases().map((u: L1UseCase): number => u.num))
            .toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
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
        const tree = new EffectiveTree(skew.main, skew.worktree, skew.worktree, skew.main, 'worktree');
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
        ];
        for (const [command, kind, dirs] of cases) {
            const tree = new EffectiveTree(
                dirs.main, dirs.worktree, dirs.worktree, dirs.main,
                kind === 'worktree' ? 'worktree' : 'primary',
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
 * 'worktree')`), so the whole matrix passed while `classify()` never emitted `'worktree'` for the only
 * worktree layout the harness produces — it emitted `'foreign'`, which row 1 exempts. A matrix spec that
 * builds its own inputs can never catch an input bug. Do not "simplify" these back to literals.
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
        const tree = new EffectiveTreeResolver().resolve(command, primary, primary);
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
