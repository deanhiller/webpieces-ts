import { describe, it, expect, vi, beforeEach } from 'vitest';

import { BranchCreationGuardConfig } from '@webpieces/rules-config';

import type { BashContext } from '../types';

// Mutable git state the mocked execSync reads. vi.hoisted so the vi.mock factory (hoisted above
// imports) can close over it without a TDZ error.
const git = vi.hoisted(() => ({ branch: 'main', behind: 0 }));

vi.mock('child_process', () => ({
    execSync: (cmd: string): string => {
        if (cmd.includes('rev-parse --abbrev-ref HEAD')) return `${git.branch}\n`;
        if (cmd.includes('rev-list')) return `${git.behind}\n`;
        return '';
    },
}));

import { BranchCreationGuardRule } from './branch-creation-guard';

function ctx(command: string): BashContext {
    return { command, workspaceRoot: '/tmp/x', options: {} } as BashContext;
}

function rule(mode: 'ON' | 'OFF' | 'ON_NO_SUBBRANCHES', extra: Partial<BranchCreationGuardConfig> = {}): BranchCreationGuardRule {
    const cfg = new BranchCreationGuardConfig();
    cfg.mode = mode;
    Object.assign(cfg, extra);
    return new BranchCreationGuardRule(cfg);
}

describe('branch-creation-guard', () => {
    beforeEach(() => {
        git.branch = 'main';
        git.behind = 0;
    });

    it('ignores commands that do not create a branch', () => {
        expect(rule('ON').check(ctx('git status')).length).toBe(0);
        expect(rule('ON_NO_SUBBRANCHES').check(ctx('git branch -d old')).length).toBe(0);
    });

    it('on up-to-date main, allows branch creation', () => {
        git.branch = 'main';
        git.behind = 0;
        expect(rule('ON').check(ctx('git checkout -b dean/feature')).length).toBe(0);
    });

    it('on stale main, blocks with a pull-first message', () => {
        git.branch = 'main';
        git.behind = 3;
        const violations = rule('ON').check(ctx('git checkout -b dean/feature'));
        expect(violations.length).toBe(1);
        expect(violations[0].message).toContain('behind origin/main');
    });

    it('mode ON: off a feature branch, blocks and still offers the sub-branch affordance', () => {
        git.branch = 'dean/existing';
        const violations = rule('ON').check(ctx('git checkout -b dean/another'));
        expect(violations.length).toBe(1);
        expect(violations[0].message).toContain("not main");
        expect(violations[0].message).toContain('subBranchNaming');
    });

    it('mode ON_NO_SUBBRANCHES: off a feature branch, blocks with strict recovery + epoch escape, no sub-branch affordance', () => {
        git.branch = 'dean/existing';
        const violations = rule('ON_NO_SUBBRANCHES').check(ctx('git checkout -b dean/another'));
        expect(violations.length).toBe(1);
        const msg = violations[0].message;
        expect(msg).toContain('git checkout main && git pull && git checkout -b dean/another');
        expect(msg).toContain('instead of branching from this branch');
        expect(msg).toContain('ignoreModifiedUntilEpoch');
        // The strict mode must NOT dangle the sub-branch naming convention.
        expect(msg).not.toContain('subBranchNaming');
    });

    it('surfaces the configured branchFormat in the block message', () => {
        git.branch = 'dean/existing';
        const format = 'Name it dean/<thing> lowercase';
        const violations = rule('ON_NO_SUBBRANCHES', { branchFormat: format }).check(ctx('git checkout -b foo'));
        expect(violations[0].message).toContain(format);
    });

    it('fixHint is mode-aware: ON_NO_SUBBRANCHES points to the epoch escape; ON points to subBranchNaming', () => {
        const flatten = (fh: { mainMessage: string; fixOptions: readonly { text: string }[] }): string =>
            [fh.mainMessage, ...fh.fixOptions.map((o: { text: string }): string => o.text)].join('\n');

        const strict = flatten(rule('ON_NO_SUBBRANCHES').fixHint);
        expect(strict).toContain('ignoreModifiedUntilEpoch');
        expect(strict).not.toContain('subBranchNaming');

        const normal = flatten(rule('ON').fixHint);
        expect(normal).toContain('subBranchNaming');
    });
});

describe('branch-creation-guard reserved wp<number> suffix', () => {
    it('blocks a branch name ending in the reserved wp<number> generation marker', () => {
        git.branch = 'main';
        git.behind = 0;
        const violations = rule('ON').check(ctx('git checkout -b dean/upgrade-webpieceswp2'));
        expect(violations.length).toBe(1);
        expect(violations[0].message).toContain('reserved');
        expect(violations[0].message).toContain('wp<number>');
    });

    it('does NOT block a name that merely contains digits or a version', () => {
        git.branch = 'main';
        git.behind = 0;
        expect(rule('ON').check(ctx('git checkout -b dean/upgrade-webpieces-0.3.213')).length).toBe(0);
    });
});
