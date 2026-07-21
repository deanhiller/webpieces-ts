import { describe, it, expect, vi } from 'vitest';

// The guard shells out for the current branch and (via TreeRecovery/WorktreeService) for the tree
// kind. Pin both so the tests are about the command-matching logic, not the ambient repo.
vi.mock('child_process', () => ({
    execSync: (): string => 'dean/feature\n',
    spawnSync: (): { status: number; stdout: string } => ({
        status: 0,
        stdout: 'worktree /repo\nHEAD aaa\nbranch refs/heads/dean/feature\n',
    }),
}));

import { PrMergeGuardConfig } from '@webpieces/rules-config';
import type { BashContext } from '../types';
import { PrMergeGuardRule } from './pr-merge-guard';

function ctx(command: string): BashContext {
    return { command, workspaceRoot: '/repo', options: {} } as BashContext;
}

function guard(): PrMergeGuardRule {
    return new PrMergeGuardRule(new PrMergeGuardConfig());
}

describe('pr-merge-guard accepts wp-cleanup as the branch delete', () => {
    /**
     * The whole point of routing cleanup through wp-cleanup: if the guard only recognised
     * `git branch -d`, it would keep blocking the exact command its own fix hint now hands out —
     * an agent that followed the instructions would be told it had not followed the instructions.
     */
    it('passes a merge chained with checkout main + pull + wp-cleanup', () => {
        const command = 'gh pr merge --squash && git checkout main && git pull origin main && pnpm wp-cleanup';
        expect(guard().check(ctx(command)).length).toBe(0);
    });

    // The narrower literal form is not wrong, just less thorough — it must keep working.
    it('still passes the literal git branch -d form', () => {
        const command = 'gh pr merge --squash && git checkout main && git pull && git branch -d dean/feature';
        expect(guard().check(ctx(command)).length).toBe(0);
    });

    it('blocks a bare merge with no cleanup at all', () => {
        expect(guard().check(ctx('gh pr merge --squash')).length).toBe(1);
    });

    // wp-cleanup deletes the branch but does NOT move you off it — and you cannot delete the branch
    // you are standing on, so the checkout is still load-bearing, not ceremony.
    it('blocks wp-cleanup without first switching to main', () => {
        expect(guard().check(ctx('gh pr merge --squash && pnpm wp-cleanup')).length).toBe(1);
    });

    it('ignores commands that are not a PR merge', () => {
        expect(guard().check(ctx('pnpm wp-cleanup')).length).toBe(0);
        expect(guard().check(ctx('gh pr list')).length).toBe(0);
    });
});
