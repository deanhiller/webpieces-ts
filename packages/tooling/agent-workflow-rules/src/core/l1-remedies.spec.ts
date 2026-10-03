import { RulePackRegistry } from '@webpieces/rules-config';
import { policyFixture } from '@webpieces/tooling-testkit';
const fixtureRuleRegistry = new RulePackRegistry(policyFixture.manifests());
import { specTempDirs } from '@webpieces/tooling-testkit';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect, beforeAll } from 'vitest';

import { isAllowed } from '../bin/shim';
import { prepareLegacyUpgrade } from '@webpieces/rules-config';
import { BlockedResult } from '@webpieces/hook-runtime';
import { VersionSyncGuard } from './version-sync';
import { EffectiveTree, EffectiveTreeResolver } from '@webpieces/hook-runtime';
import { atRoot } from '@webpieces/rules-config';
import { MissingDirectoryGuard } from './missing-directory';
import { ReadOnlyInspectionScan } from './read-only-inspection';
import {  isGitOrGhCommand, runBash  } from './runner';
import { loadTemplate } from '@webpieces/rules-config';

import { renderL1Doc } from './l1-doc';
import { LOCATION_MATRIX_DOC, locationMatrixPointer } from './l1-matrix-doc';
import { L1Classification, L1Kind, L1Row, L1UseCase, L1_ROWS, L1_PRESTAGE_ROW, L1_UNROWED_USE_CASES, allL1UseCases, firstMatchingL1Row } from './l1-rows';

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
    const base = policyFixture.makeRepo('wp-skew-');
    const main = path.join(base, 'main');
    const worktree = path.join(base, 'wt');
    for (const dir of [main, worktree]) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
        path.join(main, 'pnpm-workspace.yaml'),
        "catalog:\n  '@webpieces/webpieces-tooling': 0.4.616\n",
    );
    fs.writeFileSync(
        path.join(worktree, 'pnpm-workspace.yaml'),
        `catalog:\n  '@webpieces/webpieces-tooling': ${worktreeVersion}\n`,
    );
    return { main, worktree };
}

describe('no surface prescribes cross-tree `git -C` as a cure', () => {
    // The three message-bearing modules. shim-deny-reason.ts is excluded ON PURPOSE — it names
    // `git -C <root>` in order to say it is REFUSED, which is the story being told, not a breach of it.
    // `rules/judged-tree.ts` is here because it is a message-bearing module that renders an AIMED cure
    // — the one shape this scan exists for — and because its PLACEMENT would otherwise exempt it: the
    // list is resolved against `core/`, so a new file one directory down is outside the scan by
    // accident rather than by decision. A path-relative allowlist that silently misses a subdirectory
    // is the same defect this whole spec is about, one level up.
    const SITES = ['version-sync.ts', 'runner.ts', 'l1-rows.ts', 'rules/judged-tree.ts'] as const;

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
                .some(
                    (line: string) =>
                        line.includes('git -C <dir') && !/^\s*(\/\/|\*|\/\*)/.test(line),
                );
            if (!teaches) continue;
            expect(source, `${site} teaches git -C without bounding it to this tree`).toContain(
                'INSIDE this tree',
            );
            expect(source, `${site} teaches git -C without naming the cross-tree refusal`).toMatch(
                /another tree/i,
            );
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
        const config = prepareLegacyUpgrade({}, fixtureRuleRegistry).config as Record<string, any>;
        config.hookGuards['branch-creation-guard'].autoReapMergedBranches = false;
        for (const name of Object.keys(config.hookGuards)) config.hookGuards[name].mode = 'OFF';
        config.excludePaths = [];
        policyFixture.declareIn(root);
        policyFixture.writeOwnerConfig(root, config);
    }

    function initTempRepo(dir: string): void {
        fs.mkdirSync(dir, { recursive: true });
        const git = (...args: string[]): void => {
            execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
        };
        git('init', '-b', 'main');
        git('config', 'core.hooksPath', '/dev/null'); // never this machine's global hooks
        git('config', 'user.email', 'test@example.com');
        git('config', 'user.name', 'test');
        fs.writeFileSync(path.join(dir, 'f.txt'), 'x');
        git('add', '-A');
        git('commit', '-m', 'init');
    }

    beforeAll(() => {
        outer = specTempDirs.makeReal('wp-l1ptr-');
        initTempRepo(outer);
        writeGuardConfig(outer);
        matrixPath = path.join(outer, '.webpieces', 'instruct-ai', LOCATION_MATRIX_DOC);
    });

    it(`row ${L1_PRESTAGE_ROW} (the misplaced-\`cd\` pre-stage): absolute path + the row`, () => {
        const report = (
            runBash('ls && cd sub && pnpm build', outer, 'guards', 'claude-code') as BlockedResult
        ).report;
        expect(report).toContain('must come FIRST');
        expect(report).toContain(matrixPath);
        expect(report).toContain(`ROW ${L1_PRESTAGE_ROW}`);
    });

    it('row 5 (git from a subdirectory, force-to-root): absolute path + the row', () => {
        const sub = path.join(outer, 'packages', 'http');
        fs.mkdirSync(sub, { recursive: true });
        const report = (
            runBash(`cd ${sub} && git status`, outer, 'guards', 'claude-code') as BlockedResult
        ).report;
        expect(report).toContain(matrixPath);
        expect(report).toContain('ROW 5');
    });

    // Lazy: the doc is written on a BLOCK and nowhere else, so an agent that was never blocked never
    // pays for a file it will not read.
    it('writes the matrix only on a block', () => {
        const clean = specTempDirs.makeReal('wp-l1ptr-ok-');
        initTempRepo(clean);
        writeGuardConfig(clean);
        expect(runBash('pnpm build && pnpm test', clean, 'guards', 'claude-code')).toBeNull();
        expect(
            fs.existsSync(path.join(clean, '.webpieces', 'instruct-ai', LOCATION_MATRIX_DOC)),
        ).toBe(false);
    });

    // The DELIVERED text, not merely the pure function: it is interpolated into a JSON decision
    // payload, where a quote corrupts the decision rather than merely the prose.
    it('adds nothing to the deny that could corrupt the JSON payload', () => {
        const report = (
            runBash('ls && cd sub && pnpm build', outer, 'guards', 'claude-code') as BlockedResult
        ).report;
        const pointer = report.slice(report.indexOf('The full L1 location matrix'));
        expect(pointer).not.toContain('"');
        expect(pointer).not.toContain('\\');
    });
});
