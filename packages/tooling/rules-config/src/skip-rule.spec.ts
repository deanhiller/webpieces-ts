import { describe, it, expect, beforeEach, vi } from 'vitest';

import { shouldSkipRule } from './skip-rule';

// What `git rev-parse --abbrev-ref HEAD` reports. "HEAD" is what a real detached CI checkout of
// refs/pull/<N>/merge returns — the exact condition this suite pins.
const state = vi.hoisted(() => ({ branch: 'main' }));

vi.mock('child_process', () => ({
    execSync: (): string => `${state.branch}\n`,
}));

describe('shouldSkipRule branch hatch in a detached checkout', () => {
    beforeEach(() => {
        state.branch = 'HEAD';
        delete process.env.GITHUB_HEAD_REF;
        delete process.env.WEBPIECES_BRANCH;
    });

    it('honors the hatch from GITHUB_HEAD_REF when git only reports "HEAD"', () => {
        process.env.GITHUB_HEAD_REF = 'rename-fuse-to-theme';

        expect(shouldSkipRule(undefined, 'rename-fuse-to-theme')).toEqual({
            skip: true,
            reason: 'on branch "rename-fuse-to-theme"',
        });
    });

    it('honors the hatch from WEBPIECES_BRANCH on CI systems without GITHUB_HEAD_REF', () => {
        process.env.WEBPIECES_BRANCH = 'rename-fuse-to-theme';

        expect(shouldSkipRule(undefined, 'rename-fuse-to-theme').skip).toBe(true);
    });

    // The BUG was a silent { skip: false } here — locally green, CI red, error text never mentioning
    // the hatch. Assert the throw, not merely the happy path.
    it('THROWS when a hatch is configured and no branch can be resolved', () => {
        expect(() => shouldSkipRule(undefined, 'rename-fuse-to-theme')).toThrow(/turnOffRuleUntilEpoch/);
    });

    // The property that protects the ~all configs that never opted in: detached + null stays silent.
    it('stays silent with branchPattern null, even detached', () => {
        expect(shouldSkipRule(undefined, null)).toEqual({ skip: false });
        expect(shouldSkipRule(undefined, undefined)).toEqual({ skip: false });
    });

    it('still evaluates the epoch hatch when branchPattern is null and HEAD is detached', () => {
        const future = Date.now() / 1000 + 86400;

        expect(shouldSkipRule(future, null).skip).toBe(true);
    });

    it('does not consult env vars when git can name the branch', () => {
        state.branch = 'feature-a';
        process.env.GITHUB_HEAD_REF = '';

        expect(shouldSkipRule(undefined, 'feature-a').skip).toBe(true);
    });
});
