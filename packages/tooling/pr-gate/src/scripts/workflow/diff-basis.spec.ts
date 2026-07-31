import { describe, it, expect, afterAll, afterEach, beforeAll } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BranchNaming } from './branch-naming';
import { DiffBasis, DiffBasisResolver } from './diff-basis';
import { ForkPoint } from './git-findForkPoint';
import { GitStatusParser } from './git-status';

const dirs: string[] = [];

afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function git(cwd: string, cmd: string): void {
    execSync(cmd, { cwd, stdio: 'pipe' });
}

/**
 * The fixture repo, built ONCE and copied per test rather than `git init`-ed per test.
 *
 * MEASURED, not assumed: building it costs ~268ms (4 git spawns); copying the finished tree costs
 * ~5ms — 56x. That difference is not about speed for its own sake. Every one of those spawns runs
 * through `execSync`, which BLOCKS this worker's event loop, and a blocked worker cannot process
 * vitest's `onTaskUpdate` acks. Let one spec file block long enough and an in-flight ack passes
 * birpc's hardcoded 60s timeout, and the whole run is reported as FAILED with every test passing.
 *
 * So the spawn count in a git-heavy spec is not a tidiness concern — it is the flake budget.
 */
let template = '';

beforeAll(() => {
    template = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-basis-tpl-'));
    git(template, 'git init -q -b main');
    // core.hooksPath=/dev/null: this developer has a GLOBAL core.hooksPath, so every `git commit` in a
    // throwaway repo fires their real hooks — measured at 460ms vs 13ms, 35x, and almost all of it spent
    // WAITING (0.03s CPU of 0.46s). That cost lands on `execSync`, which blocks this worker's event loop
    // and is what pushes an in-flight vitest ack past its 60s timeout. Ten other specs already do this.
    git(template, 'git config core.hooksPath /dev/null');
    git(template, 'git config user.email t@t.t && git config user.name t');
    fs.writeFileSync(path.join(template, 'base.txt'), 'base\n');
    git(template, 'git add -A && git commit -q -m base');
    git(template, 'git checkout -q -b feat');
});

afterAll(() => {
    if (template !== '') fs.rmSync(template, { recursive: true, force: true });
});

function repoOnFeatureBranch(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-basis-'));
    dirs.push(dir);
    fs.cpSync(template, dir, { recursive: true });
    return dir;
}

function resolverFor(): DiffBasisResolver {
    return new DiffBasisResolver(new ForkPoint(null as never, null as never, null as never), new GitStatusParser());
}

describe('DiffBasisResolver — the command must match the range', () => {
    it('a CLEAN tree gets a commit-to-commit command with a real head sha', () => {
        const dir = repoOnFeatureBranch();
        fs.writeFileSync(path.join(dir, 'a.ts'), 'x\n');
        git(dir, 'git add -A && git commit -q -m work');
        const basis = resolverFor().resolve(dir);

        expect(basis.dirty).toBe(false);
        expect(basis.dirtyFiles).toEqual([]);
        // The HEAD sha, never the literal string. 'HEAD' cannot be compared later to detect that the tree
        // moved under a review, which is exactly what the stage-② receipt needs it for.
        expect(basis.headSha).toMatch(/^[0-9a-f]{40}$/);
        expect(basis.diffCommand).toBe(`git diff ${basis.base} ${basis.headSha}`);
        expect(basis.fileDiffCommand).toBe(`git diff ${basis.base} ${basis.headSha} -- <file>`);
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
    it('a DIRTY tree gets a base-to-working-tree command with NO head', () => {
        const dir = repoOnFeatureBranch();
        fs.writeFileSync(path.join(dir, 'a.ts'), 'x\n');
        git(dir, 'git add -A && git commit -q -m work');
        fs.writeFileSync(path.join(dir, 'a.ts'), 'x\nuncommitted\n');
        const basis = resolverFor().resolve(dir);

        expect(basis.dirty).toBe(true);
        expect(basis.diffCommand).toBe(`git diff ${basis.base}`);
        expect(basis.fileDiffCommand).toBe(`git diff ${basis.base} -- <file>`);
        expect(basis.fileDiffCommand).not.toContain('HEAD');
    });

    // The command has to be RUNNABLE, not merely well-formed. This is what proves the dirty form actually
    // surfaces uncommitted work and the naive `<base> HEAD` form would not have.
    it('the dirty command really returns the uncommitted change, and `<base> HEAD` really returns nothing', () => {
        const dir = repoOnFeatureBranch();
        fs.writeFileSync(path.join(dir, 'a.ts'), 'committed\n');
        git(dir, 'git add -A && git commit -q -m work');
        fs.writeFileSync(path.join(dir, 'a.ts'), 'committed\nUNCOMMITTED_MARKER\n');
        const basis = resolverFor().resolve(dir);

        const actual = execSync(basis.diffCommand, { cwd: dir, encoding: 'utf8' });
        expect(actual).toContain('UNCOMMITTED_MARKER');

        const naive = execSync(`git diff ${basis.base} HEAD`, { cwd: dir, encoding: 'utf8' });
        expect(naive).not.toContain('UNCOMMITTED_MARKER');
    });

});

// Split out to keep each describe under the method-length limit.
describe('DiffBasisResolver — dirtiness and degenerate repos', () => {
    // An UNTRACKED file is the case a `git status` that ignores `??` would miss, and it is exactly how a
    // brand-new migration or terraform rule arrives — the moment a checklist most wants to fire.
    it('counts untracked files as dirty and names them', () => {
        const dir = repoOnFeatureBranch();
        fs.writeFileSync(path.join(dir, 'brand-new.sql'), 'CREATE TABLE t();\n');
        const basis = resolverFor().resolve(dir);

        expect(basis.dirty).toBe(true);
        expect(basis.dirtyFiles).toContain('brand-new.sql');
    });

    // No fork point is a VALUE, never an exception — wp-review-upsert-pr must still be able to report.
    it('reports an unresolvable base rather than throwing', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-basis-nomain-'));
        dirs.push(dir);
        git(dir, 'git init -q -b solo');
        git(dir, 'git config core.hooksPath /dev/null');
        git(dir, 'git config user.email t@t.t && git config user.name t');
        fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
        git(dir, 'git add -A && git commit -q -m only');

        const basis = resolverFor().resolve(dir);
        expect(basis.unresolved).toBe(true);
        // No base ⇒ NO command. Inventing one would hand a reviewer something that cannot work.
        expect(basis.diffCommand).toBe('');
        expect(basis.fileDiffCommand).toBe('');
    });

    it('a default-constructed basis is unresolved, so a caller cannot mistake it for a real one', () => {
        expect(new DiffBasis().unresolved).toBe(true);
    });
});

// A rename is reported by porcelain as `R  old -> new`; the NEW name is the one on disk, so it is the one
// a reviewer can open. Taking the whole string (or the old name) would hand out an unopenable path.
describe('DiffBasisResolver — porcelain parsing', () => {
    it('takes the destination side of a rename', () => {
        const dir = repoOnFeatureBranch();
        fs.writeFileSync(path.join(dir, 'old-name.ts'), 'x\n');
        git(dir, 'git add -A && git commit -q -m add');
        git(dir, 'git mv old-name.ts new-name.ts');

        const basis = resolverFor().resolve(dir);
        expect(basis.dirtyFiles).toContain('new-name.ts');
        expect(basis.dirtyFiles).not.toContain('old-name.ts');
    });

    /**
     * Regression: dirtyPaths used to run `.trim()` over the WHOLE porcelain output and then `slice(3)`
     * each line. The first entry of an unstaged-only tree starts with a space (" M a.ts"), so the trim
     * shifted line 1 left by one and slice(3) bit a character off the front of its path — `a.ts` was
     * reported as `ts`. Only the FIRST line was affected, which is why it survived so long.
     */
    it('does not eat the first character of the first path when the first entry is unstaged', () => {
        const dir = repoOnFeatureBranch();
        fs.writeFileSync(path.join(dir, 'alpha.ts'), 'x\n');
        fs.writeFileSync(path.join(dir, 'beta.ts'), 'x\n');
        git(dir, 'git add -A && git commit -q -m add');
        fs.writeFileSync(path.join(dir, 'alpha.ts'), 'changed\n');
        fs.writeFileSync(path.join(dir, 'beta.ts'), 'changed\n');

        const basis = resolverFor().resolve(dir);
        expect(basis.dirtyFiles).toEqual(['alpha.ts', 'beta.ts']);
    });

    it('reports a space-containing path unquoted, so checklist globs can match it', () => {
        const dir = repoOnFeatureBranch();
        fs.writeFileSync(path.join(dir, 'a file.ts'), 'x\n');

        const basis = resolverFor().resolve(dir);
        expect(basis.dirtyFiles).toEqual(['a file.ts']);
    });

    it('BranchNaming is untouched by any of this (guard against an accidental coupling)', () => {
        expect(new BranchNaming()).toBeDefined();
    });
});
