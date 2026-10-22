import { describe, it, expect, beforeEach } from 'vitest';
import { toError } from '@webpieces/tooling-common/to-error';
import { PrGateFeature } from '../../__tests__/feature-harness';
import { BuildArtifactGate, BuildArtifactVerdict } from './build-artifact-gate';
import { GeneratedArtifactRegistry, GeneratedArtifacts, ARTIFACT_SOURCE_NX } from './generated-artifact-registry';
import { GitStatusEntry, GitStatusParser } from './git-status';

// The "known generated" set a real nx graph would hand us for this monorepo.
const KNOWN = new GeneratedArtifacts(
    ['packages/tooling/pr-gate/design.json', 'packages/tooling/pr-gate/design.md', 'architecture/dependencies.json'],
    ARTIFACT_SOURCE_NX,
);

let feature: PrGateFeature;

beforeEach(async (): Promise<void> => {
    feature = await PrGateFeature.create();
});

/**
 * The production gate from the shipped container, with the registry seeded to KNOWN (its own spec covers
 * reading the nx graph) and git SCRIPTED (#1381): the gate asks one question, `git status --porcelain`.
 */
function newGate(): BuildArtifactGate {
    feature.container.get(GeneratedArtifactRegistry).seed(KNOWN);
    return feature.container.get(BuildArtifactGate);
}

// The gate takes PARSED entries, so the specs still drive it with literal porcelain text — they just
// go through the same parser production does, untrimmed.
const classify = (porcelain: string): BuildArtifactVerdict =>
    newGate().classify(new GitStatusParser().parse(porcelain), KNOWN);
const paths = (entries: readonly GitStatusEntry[]): string[] => entries.map((d: GitStatusEntry): string => d.path);

/** Run the gate over a tree whose `git status --porcelain` prints `porcelain`; its failure message, or ''. */
function gateMessage(porcelain: string): Promise<string> {
    feature.git.respond(['status', '--porcelain'], feature.git.ok(porcelain));
    return newGate().assertBuildLeftNothingUncommitted('/repo').then(
        (): string => '',
        (err: unknown): string => toError(err).message);
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

describe('assertBuildLeftNothingUncommitted — what git says the build left behind', () => {
    it('passes on a clean tree', async () => {
        expect(await gateMessage('')).toBe('');
    });

    it('passes when the regenerated file is STAGED but not yet committed', async () => {
        expect(await gateMessage('M  architecture/dependencies.json\n')).toBe('');
    });

    it('fails with the "run the build and commit" message when a known generated file is dirty', async () => {
        const message = await gateMessage(' M architecture/dependencies.json\n');
        expect(message).toContain('and commit the regenerated design files');
        expect(message).toContain('architecture/dependencies.json');
        expect(message).not.toContain('generating uncommitted git artifacts');
    });

    it('fails with the "generating uncommitted git artifacts" message for an undeclared path', async () => {
        const message = await gateMessage('?? surprise.out\n');
        expect(message).toContain('generating uncommitted git artifacts');
        expect(message).toContain('.gitignore');
        expect(message).toContain('surprise.out');
        expect(message).not.toContain('and commit the regenerated design files');
    });

    it('reports BOTH sections when a generated file and a stray file are dirty together', async () => {
        const message = await gateMessage(' M architecture/dependencies.json\n?? surprise.out\n');
        expect(message).toContain('and commit the regenerated design files');
        expect(message).toContain('generating uncommitted git artifacts');
    });
});
