import { describe, it, expect } from 'vitest';
import { prDirFor } from '@webpieces/rules-config';
import { forkPointOutputDir } from './git-findForkPoint';
import { mergeDirFor } from './merge-state';

// Regression guard for the fork-point dir mismatch: findForkPoint USED to write
// updatemain-hashes.json to the legacy flat `.webpieces/<workflow>-<feature>/`, while every reader
// (git-gatherInfo / merge-start) reads it from the nested mergeDirFor (`.webpieces/merge-info/...`).
// The writer and the readers MUST resolve to the same dir, so we pin that invariant here: if anyone
// re-introduces a divergent path, this fails.
describe('forkPointOutputDir — writer dir matches the reader dir', () => {
    const repoRoot = '/repo';
    const featureName = 'dean-feature';

    it("the 'merge' workflow writes where git-gatherInfo / merge-start read (mergeDirFor)", () => {
        expect(forkPointOutputDir(repoRoot, featureName, 'merge')).toBe(mergeDirFor(repoRoot, featureName));
    });

    it("the 'review' workflow writes into prDirFor", () => {
        expect(forkPointOutputDir(repoRoot, featureName, 'review')).toBe(prDirFor(repoRoot, featureName));
    });

    it('uses the nested merge-info layout, not the legacy flat merge-<feature> dir', () => {
        const dir = forkPointOutputDir(repoRoot, featureName, 'merge');
        expect(dir).toContain('merge-info');
        expect(dir.endsWith(`merge-${featureName}`)).toBe(false);
    });
});
