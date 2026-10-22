import { MockGitProcessApi, specTempDirs } from '@webpieces/tooling-testkit';
import { describe, it, expect, beforeEach } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { GitProcessClient } from '@webpieces/tooling-common';
import { PrGateFeature } from '../../__tests__/feature-harness';
import { BranchNaming } from './branch-naming';
import { DiffBasis, DiffBasisResolver } from './diff-basis';
import { ForkPoint } from './git-findForkPoint';
import { GitStatusParser } from './git-status';

/**
 * DiffBasisResolver from the shipped container, with git SCRIPTED (#1381). It asks git four things — the
 * fork point (`merge-base origin/main HEAD`, falling back to `main`), HEAD's sha, origin/main's sha, and
 * the full porcelain status — and every answer below is what git prints for the tree each test describes.
 *
 * One test still runs a real git: the one proving that the DIRTY command shape really surfaces
 * uncommitted work while `<base> HEAD` does not. That is a fact about git, and a script cannot prove it.
 */

const REPO = '/repo';
const BASE = 'b'.repeat(40);
const HEAD = 'h'.repeat(40);
const MAIN = 'm'.repeat(40);

let feature: PrGateFeature;
let git: MockGitProcessApi;

/** A feature branch forked from main at BASE, whose working tree prints `porcelain`. */
function treeIs(porcelain: string): void {
    git.respond(['merge-base', 'origin/main', 'HEAD'], git.ok(`${BASE}\n`));
    git.respond(['rev-parse', 'HEAD'], git.ok(`${HEAD}\n`));
    git.respond(['rev-parse', 'origin/main'], git.ok(`${MAIN}\n`));
    git.respond(['status', '--porcelain', '--untracked-files=all'], git.ok(porcelain));
}

function resolve(): Promise<DiffBasis> {
    return feature.container.get(DiffBasisResolver).resolve(REPO);
}

beforeEach(async () => {
    feature = await PrGateFeature.create();
    git = feature.git;
});

describe('DiffBasisResolver — the command must match the range', () => {
    it('a CLEAN tree gets a commit-to-commit command with a real head sha', async () => {
        treeIs('');
        const basis = await resolve();

        expect(basis.dirty).toBe(false);
        expect(basis.dirtyFiles).toEqual([]);
        // The HEAD sha, never the literal string. 'HEAD' cannot be compared later to detect that the tree
        // moved under a review, which is exactly what the stage-② receipt needs it for.
        expect(basis.headSha).toBe(HEAD);
        expect(basis.hashMainHead).toBe(MAIN);
        expect(basis.diffCommand).toBe(`git diff ${BASE} ${HEAD}`);
        expect(basis.fileDiffCommand).toBe(`git diff ${BASE} ${HEAD} -- <file>`);
        // Every question was asked IN the repo, and offline — nothing here may fetch.
        expect(git.calls.every((c): boolean => c.cwd === REPO)).toBe(true);
        expect(git.commandLines().some((l: string): boolean => l.includes('fetch'))).toBe(false);
    });

    /**
     * THE regression test.
     *
     * The changed-FILE set is computed base→WORKING TREE (that is what makes wp-review-upsert-pr see
     * uncommitted work). Reviewers were nonetheless handed `git diff <base> HEAD -- <file>`, which on a
     * dirty tree is a DIFFERENT range and comes back empty — a file list plus a command that shows nothing.
     * A real reviewer subagent ran it, got no output, and had to guess its way to `git diff HEAD`.
     *
     * So on a dirty tree the command must carry NO head. Asserting the absence of ` HEAD` is the point:
     * that token coming back IS the bug.
     */
    it('a DIRTY tree gets a base-to-working-tree command with NO head', async () => {
        treeIs(' M a.ts\n');
        const basis = await resolve();

        expect(basis.dirty).toBe(true);
        expect(basis.diffCommand).toBe(`git diff ${BASE}`);
        expect(basis.fileDiffCommand).toBe(`git diff ${BASE} -- <file>`);
        expect(basis.fileDiffCommand).not.toContain('HEAD');
    });

    // The command has to be RUNNABLE, not merely well-formed — against a REAL git, because this is a fact
    // about git: the dirty form surfaces uncommitted work and the naive `<base> HEAD` form does not.
    it('the dirty command really returns the uncommitted change, and `<base> HEAD` really returns nothing', async () => {
        const dir = specTempDirs.make('wp-basis-');
        const run = (cmd: string): void => { execSync(cmd, { cwd: dir, stdio: 'pipe' }); };
        run('git init -q -b main && git config core.hooksPath /dev/null && git config user.email t@t.t && git config user.name t');
        fs.writeFileSync(path.join(dir, 'a.ts'), 'committed\n');
        run('git add -A && git commit -q -m base && git checkout -q -b feat');
        fs.writeFileSync(path.join(dir, 'a.ts'), 'committed\nUNCOMMITTED_MARKER\n');
        const real = new GitProcessClient();
        const basis = await new DiffBasisResolver(
            new ForkPoint(null as never, null as never, null as never, null as never, real), new GitStatusParser(), real).resolve(dir);

        expect(execSync(basis.diffCommand, { cwd: dir, encoding: 'utf8' })).toContain('UNCOMMITTED_MARKER');
        expect(execSync(`git diff ${basis.base} HEAD`, { cwd: dir, encoding: 'utf8' })).not.toContain('UNCOMMITTED_MARKER');
        fs.rmSync(dir, { recursive: true, force: true });
    });
});

// Split out to keep each describe under the method-length limit.
describe('DiffBasisResolver — dirtiness and degenerate repos', () => {
    // An UNTRACKED file is the case a `git status` that ignores `??` would miss, and it is exactly how a
    // brand-new migration or terraform rule arrives — the moment a checklist most wants to fire.
    it('counts untracked files as dirty and names them', async () => {
        treeIs('?? brand-new.sql\n');
        const basis = await resolve();

        expect(basis.dirty).toBe(true);
        expect(basis.dirtyFiles).toContain('brand-new.sql');
    });

    // No fork point is a VALUE, never an exception — wp-review-upsert-pr must still be able to report.
    it('reports an unresolvable base rather than throwing', async () => {
        git.respond(['merge-base', 'origin/main', 'HEAD'], git.fail(128, 'fatal: Not a valid object name origin/main'));
        git.respond(['merge-base', 'main', 'HEAD'], git.fail(128, 'fatal: Not a valid object name main'));
        git.respond(['rev-parse', 'HEAD'], git.ok(`${HEAD}\n`));
        git.respond(['rev-parse', 'origin/main'], git.fail(128, 'fatal: ambiguous argument'));
        git.respond(['status', '--porcelain', '--untracked-files=all'], git.ok(''));

        const basis = await resolve();
        expect(basis.unresolved).toBe(true);
        // No base ⇒ NO command. Inventing one would hand a reviewer something that cannot work.
        expect(basis.diffCommand).toBe('');
        expect(basis.fileDiffCommand).toBe('');
        expect(basis.hashMainHead).toBe('');
    });

    it('falls back to a LOCAL main when origin/main does not resolve', async () => {
        git.respond(['merge-base', 'origin/main', 'HEAD'], git.fail(128, 'fatal: Not a valid object name origin/main'));
        git.respond(['merge-base', 'main', 'HEAD'], git.ok(`${BASE}\n`));
        git.respond(['rev-parse', 'HEAD'], git.ok(`${HEAD}\n`));
        git.respond(['rev-parse', 'origin/main'], git.fail(128, 'fatal: ambiguous argument'));
        git.respond(['status', '--porcelain', '--untracked-files=all'], git.ok(''));

        expect((await resolve()).base).toBe(BASE);
    });

    it('a default-constructed basis is unresolved, so a caller cannot mistake it for a real one', () => {
        expect(new DiffBasis().unresolved).toBe(true);
    });
});

// A rename is reported by porcelain as `R  old -> new`; the NEW name is the one on disk, so it is the one
// a reviewer can open. Taking the whole string (or the old name) would hand out an unopenable path.
describe('DiffBasisResolver — porcelain parsing', () => {
    it('takes the destination side of a rename', async () => {
        treeIs('R  old-name.ts -> new-name.ts\n');

        const basis = await resolve();
        expect(basis.dirtyFiles).toContain('new-name.ts');
        expect(basis.dirtyFiles).not.toContain('old-name.ts');
    });

    /**
     * Regression: dirtyPaths used to run `.trim()` over the WHOLE porcelain output and then `slice(3)`
     * each line. The first entry of an unstaged-only tree starts with a space (" M a.ts"), so the trim
     * shifted line 1 left by one and slice(3) bit a character off the front of its path — `a.ts` was
     * reported as `ts`. Only the FIRST line was affected, which is why it survived so long.
     */
    it('does not eat the first character of the first path when the first entry is unstaged', async () => {
        treeIs(' M alpha.ts\n M beta.ts\n');

        const basis = await resolve();
        expect(basis.dirtyFiles).toEqual(['alpha.ts', 'beta.ts']);
    });

    it('reports a space-containing path unquoted, so checklist globs can match it', async () => {
        treeIs('?? "a file.ts"\n');

        const basis = await resolve();
        expect(basis.dirtyFiles).toEqual(['a file.ts']);
    });

    it('BranchNaming is untouched by any of this (guard against an accidental coupling)', () => {
        expect(new BranchNaming()).toBeDefined();
    });
});
