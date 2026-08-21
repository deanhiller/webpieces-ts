import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { BuildsLog, DotWebpieces, HomeConfigService, RepoRootFinder, toError } from '@webpieces/rules-config';
import { BuildAffected } from './build-affected';
import { BuildGateLog } from './build-gate-log';
import { BuildArtifactGate, BuildArtifactVerdict } from './build-artifact-gate';
import { GeneratedArtifactRegistry, GeneratedArtifacts, ARTIFACT_SOURCE_NX } from './generated-artifact-registry';
import { GitExec } from './git-exec';
import { GitStatusEntry, GitStatusParser } from './git-status';

// The "known generated" set a real nx graph would hand us for this monorepo.
const KNOWN = new GeneratedArtifacts(
    ['packages/tooling/pr-gate/design.json', 'packages/tooling/pr-gate/design.md', 'architecture/dependencies.json'],
    ARTIFACT_SOURCE_NX,
);

function newGate(): BuildArtifactGate {
    const registry = new GeneratedArtifactRegistry();
    registry.seed(KNOWN);
    return new BuildArtifactGate(new GitExec(new RepoRootFinder(), new GitStatusParser()), registry, new BuildAffected(new HomeConfigService(), new BuildGateLog(), new BuildsLog(new DotWebpieces())));
}

// The gate takes PARSED entries, so the specs still drive it with literal porcelain text — they just
// go through the same parser production does, untrimmed.
const classify = (porcelain: string): BuildArtifactVerdict =>
    newGate().classify(new GitStatusParser().parse(porcelain), KNOWN);
const paths = (entries: readonly GitStatusEntry[]): string[] => entries.map((d: GitStatusEntry): string => d.path);

/**
 * Run the gate and hand back the failure message ('' when it passed), so each case costs ONE git
 * invocation instead of one per assertion. Spawning git is by far the slowest thing in this file.
 */
function gateMessage(dir: string): string {
    // webpieces-disable no-unmanaged-exceptions -- chokepoint: a spec helper whose whole job is to
    // capture the CliExitError message the gate throws so the assertions can read it
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        newGate().assertBuildLeftNothingUncommitted(dir);
    } catch (err: unknown) {
        const error = toError(err);
        return error.message;
    }
    return '';
}

// ONE throwaway repo for the whole real-git block, restored between cases: `git init` + config +
// initial commit is 8 subprocesses, and paying that per test is what made this file slow enough to
// starve vitest's reporter under a parallel full-suite run.
let repo = '';

function initRepo(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-artifactgate-'));
    const run = (args: string): void => { execSync(`git ${args}`, { cwd: dir, stdio: 'ignore' }); };
    run('init -q');
    run('config core.hooksPath /dev/null');
    run('config user.email test@example.com');
    run('config user.name test');
    run('config commit.gpgsign false');
    fs.mkdirSync(path.join(dir, 'architecture'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'architecture', 'dependencies.json'), '{}\n');
    fs.writeFileSync(path.join(dir, 'src.ts'), 'export const a = 1;\n');
    run('add -A');
    run('commit -q -m initial');
    return dir;
}

function resetRepo(): void {
    execSync('git reset -q --hard HEAD && git clean -qfd', { cwd: repo, stdio: 'ignore' });
}

describe('classify — the "committed OR staged" predicate', () => {
    it('verdict 1: a dirty KNOWN generated file is a stale-design failure', () => {
        const v = classify(' M packages/tooling/pr-gate/design.json');
        expect(v.isClean()).toBe(false);
        expect(paths(v.staleGenerated)).toEqual(['packages/tooling/pr-gate/design.json']);
        expect(v.strayArtifacts).toEqual([]);
    });

    it('verdict 2: a dirty UNKNOWN file is a stray-build-artifact failure', () => {
        const v = classify(' M packages/tooling/pr-gate/scratch.txt');
        expect(paths(v.strayArtifacts)).toEqual(['packages/tooling/pr-gate/scratch.txt']);
        expect(v.staleGenerated).toEqual([]);
    });

    it('an untracked (??) file the build created counts, and counts as STRAY when undeclared', () => {
        const v = classify('?? build-output/report.html');
        expect(v.strayArtifacts.length).toBe(1);
        expect(v.strayArtifacts[0].isUntracked()).toBe(true);
    });

    it('STAGED satisfies the contract — this is what makes it work mid-3-point-merge', () => {
        // Column 1 = index, column 2 = worktree. "M " is staged with a clean worktree.
        expect(classify('M  packages/tooling/pr-gate/design.json').isClean()).toBe(true);
        expect(classify('A  brand/new/file.ts').isClean()).toBe(true);
        expect(classify('R  old.ts -> new.ts').isClean()).toBe(true);
    });

    it('but PARTIALLY staged (MM / AM) is still dirty — column 2 is what decides', () => {
        expect(classify('MM packages/tooling/pr-gate/design.json').isClean()).toBe(false);
        expect(classify('AM brand/new/file.ts').isClean()).toBe(false);
    });

    it('an empty porcelain (clean tree) passes', () => {
        expect(classify('').isClean()).toBe(true);
    });

    it('both dirty at once reports BOTH, each in its own bucket', () => {
        const v = classify([
            ' M architecture/dependencies.json',
            ' M packages/tooling/pr-gate/design.md',
            '?? stray/thing.txt',
            ' M some/other/file.ts',
        ].join('\n'));
        expect(paths(v.staleGenerated)).toEqual(['architecture/dependencies.json', 'packages/tooling/pr-gate/design.md']);
        expect(paths(v.strayArtifacts)).toEqual(['stray/thing.txt', 'some/other/file.ts']);
    });

    it('classifies the NEW path of a rename, not the old one', () => {
        const v = classify('RM architecture/old.json -> architecture/dependencies.json');
        expect(paths(v.staleGenerated)).toEqual(['architecture/dependencies.json']);
    });

    it('unquotes a path git quoted because it has spaces', () => {
        const v = classify(' M "a file/with spaces.txt"');
        expect(v.strayArtifacts[0].path).toBe('a file/with spaces.txt');
    });
});

describe('assertBuildLeftNothingUncommitted — against a real git repo', () => {
    beforeAll((): void => { repo = initRepo(); });
    beforeEach((): void => { resetRepo(); });

    const dirty = (rel: string): void => { fs.writeFileSync(path.join(repo, rel), `${Date.now()}\n`); };

    it('passes on a clean tree', () => {
        expect(gateMessage(repo)).toBe('');
    });

    it('passes when the regenerated file is STAGED but not yet committed', () => {
        dirty('architecture/dependencies.json');
        execSync('git add architecture/dependencies.json', { cwd: repo, stdio: 'ignore' });
        expect(gateMessage(repo)).toBe('');
    });

    it('fails with the "run the build and commit" message when a known generated file is dirty', () => {
        dirty('architecture/dependencies.json');
        const message = gateMessage(repo);
        expect(message).toContain('and commit the regenerated design files');
        expect(message).toContain('architecture/dependencies.json');
        expect(message).not.toContain('generating uncommitted git artifacts');
    });

    it('fails with the "generating uncommitted git artifacts" message for an undeclared path', () => {
        dirty('surprise.out');
        const message = gateMessage(repo);
        expect(message).toContain('generating uncommitted git artifacts');
        expect(message).toContain('.gitignore');
        expect(message).toContain('surprise.out');
        expect(message).not.toContain('and commit the regenerated design files');
    });

    it('reports BOTH sections when a generated file and a stray file are dirty together', () => {
        dirty('architecture/dependencies.json');
        dirty('surprise.out');
        const message = gateMessage(repo);
        expect(message).toContain('and commit the regenerated design files');
        expect(message).toContain('generating uncommitted git artifacts');
    });
});
