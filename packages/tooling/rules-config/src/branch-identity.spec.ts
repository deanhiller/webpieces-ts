import { afterEach, describe, expect, it, vi } from 'vitest';
import { BranchIdentity } from './skip-rule';

afterEach(() => {
    vi.unstubAllEnvs();
});

describe('BranchIdentity', () => {
    const identity = new BranchIdentity();

    it('matches only the exact, case-sensitive interior /hotfix/ segment', () => {
        expect(identity.isHotfix('1027/hotfix/fix-timeout')).toBe(true);
        expect(identity.isHotfix('dean/1027/hotfix/fix-timeout')).toBe(true);
        expect(identity.isHotfix('dean/hotfix/fix-timeout')).toBe(true);
        expect(identity.isHotfix('dean/Hotfix/fix-timeout')).toBe(false);
        expect(identity.isHotfix('dean/hotfix-fix-timeout')).toBe(false);
        expect(identity.isHotfix('dean/notahotfix/fix-timeout')).toBe(false);
        expect(identity.isHotfix('hotfix/fix-timeout')).toBe(false);
    });

    it('resolves GitHub pull-request identity before the portable override', () => {
        vi.stubEnv('GITHUB_HEAD_REF', 'dean/hotfix/from-github');
        vi.stubEnv('WEBPIECES_BRANCH', 'dean/normal');
        expect(identity.current()).toBe('dean/hotfix/from-github');
        expect(identity.isHotfix()).toBe(true);
    });

    it('uses WEBPIECES_BRANCH when GitHub did not supply a head ref', () => {
        vi.stubEnv('GITHUB_HEAD_REF', '');
        vi.stubEnv('WEBPIECES_BRANCH', 'dean/hotfix/from-ci');
        expect(identity.current()).toBe('dean/hotfix/from-ci');
        expect(identity.isHotfix()).toBe(true);
    });
});
