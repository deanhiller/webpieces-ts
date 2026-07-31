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
import { BashContext } from '../types';
import { PrMergeGuardRule } from './pr-merge-guard';

function ctx(command: string): BashContext {
    return new BashContext(command, '/repo');
}

function guard(): PrMergeGuardRule {
    return new PrMergeGuardRule(new PrMergeGuardConfig());
}

describe('pr-merge-guard redirects every hand-rolled merge to wp-land-pr', () => {
    it('blocks a bare merge', () => {
        expect(guard().check(ctx('gh pr merge --squash')).length).toBe(1);
    });

    /**
     * There is deliberately NO "but I cleaned up afterwards" escape any more. The damage a raw
     * `gh pr merge` does is the commit message it writes into main — GitHub falls back to the repo's
     * squash_merge_commit_title/message, which can never yield the compact risk/flags body. Cleanup
     * happens after the merge and cannot undo that, so it was never a valid excuse for the merge.
     */
    it('still blocks a merge chained with the full cleanup — cleanup does not fix the commit message', () => {
        const command = 'gh pr merge --squash && git checkout main && git pull origin main && pnpm wp-cleanup';
        expect(guard().check(ctx(command)).length).toBe(1);
    });

    it('still blocks the literal git branch -d form for the same reason', () => {
        const command = 'gh pr merge --squash && git checkout main && git pull && git branch -d dean/feature';
        expect(guard().check(ctx(command)).length).toBe(1);
    });

    // The command the fix hint hands out must not itself trip the guard, or an agent that followed
    // the instructions would be told it had not followed the instructions. wp-land-pr's own
    // `gh pr merge` runs as a child process the hook never sees.
    it('lets `pnpm wp-land-pr` through', () => {
        expect(guard().check(ctx('pnpm wp-land-pr')).length).toBe(0);
        expect(guard().check(ctx('pnpm wp-land-pr && pnpm wp-cleanup')).length).toBe(0);
    });

    // The exact command that this feature's own commit was blocked by: a commit message DESCRIBING
    // the redirect. Matching is on ctx.commandCode, which drops heredoc bodies and quoted prose.
    it('does not block a commit message that merely mentions merging', () => {
        expect(guard().check(ctx("git commit -F - <<'EOF'\nredirect a hand-rolled gh pr merge to wp-land-pr\nEOF")).length).toBe(0);
        expect(guard().check(ctx('git commit -m "explain why gh pr merge is blocked"')).length).toBe(0);
    });

    it('ignores commands that are not a PR merge', () => {
        expect(guard().check(ctx('pnpm wp-cleanup')).length).toBe(0);
        expect(guard().check(ctx('gh pr list')).length).toBe(0);
    });

    it('names `pnpm wp-land-pr` in the fix hint, and still prints the cleanup steps', () => {
        const g = guard();
        g.check(ctx('gh pr merge --squash'));
        const hint = `${g.fixHint.mainMessage}\n${g.fixHint.options}`;
        expect(hint).toContain('pnpm wp-land-pr');
        expect(hint).toContain('wp-cleanup');
    });

    /**
     * EVERY mention of the command in this hint must carry its `pnpm`. The hint is a block an agent
     * follows verbatim, and a bare `wp-land-pr` is not something anyone can type. The one that WAS
     * bare — "and `wp-land-pr` passes exactly the pair…" — sat two lines above the runnable form,
     * which is precisely the line an agent copies from.
     */
    it('never names wp-land-pr without its pnpm prefix', () => {
        const g = guard();
        g.check(ctx('gh pr merge --squash'));
        const hint = `${g.fixHint.mainMessage}\n${g.fixHint.options}`;
        const bare = hint.split('\n')
            .map((line: string): string => line.replace(/pnpm wp-land-pr/g, ''))
            .filter((line: string): boolean => line.includes('wp-land-pr'));
        expect(bare).toEqual([]);
    });
});
