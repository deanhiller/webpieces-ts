import { execSync } from 'child_process';

import { PrMergeGuardConfig } from '@webpieces/rules-config';

import type { BashContext, Violation } from '../types';
import { Violation as V } from '../types';
import { BashRuleBase } from '../rule-base';
import { FixHint } from '../fix-hint';
import { TreeRecovery, TreeKind } from './tree-recovery';

function truncate(s: string): string {
    const MAX = 120;
    return s.length <= MAX ? s : s.slice(0, MAX) + '…';
}

export class PrMergeGuardRule extends BashRuleBase<PrMergeGuardConfig> {
    constructor(config: PrMergeGuardConfig) { super(config, 'pr-merge-guard'); }

    readonly description = 'After merging a PR, require switching to main, pulling, and deleting the local branch.';

    // Substituted with the real branch name in check(); the getter reads it. Placeholder until then.
    private currentBranch = '<current-branch>';

    // The tree we are standing in, resolved in check() so fixHint renders the ONE cleanup that
    // actually works here. 'unknown' until check() runs (fixHint is also read before/without it).
    private treeKind: TreeKind = 'unknown';
    private worktreePath = '<worktree-dir>';

    private readonly recovery = new TreeRecovery();

    // Single fix, no distinct options — the whole guidance lives in mainMessage so it renders as
    // one coherent block (never split into fake "Fix Option 1/2/3").
    get fixHint(): FixHint {
        return new FixHint(
            'After merging a PR you must clean up the branch (and the worktree, if it has one).',
            ['Run `gh pr merge --squash`, then:', '']
                .concat(this.recovery.cleanupSteps(this.treeKind, this.currentBranch, this.worktreePath))
                .concat(['', "Add this to your memory so you don't forget next time and waste tokens."])
                .join('\n'),
        );
    }

    /**
     * The accepted cleanups differ by tree, so the "already cleaning up" detection has to as well:
     * in a linked worktree `git checkout main` FATALS, so demanding it there would be demanding an
     * impossible command. A worktree is cleaned up by `git worktree remove` + `git branch -D`.
     */
    check(ctx: BashContext): readonly Violation[] {
        if (!/gh\s+pr\s+merge/.test(ctx.command)) return [];

        const hasDelete = /git\s+branch\s+-[dD]/.test(ctx.command);
        const hasCheckout = /git\s+(checkout|switch)\s+main/.test(ctx.command);
        const hasWorktreeRemove = /git\s+worktree\s+remove\b/.test(ctx.command);

        this.treeKind = this.recovery.kindOf(ctx.workspaceRoot);
        if (this.treeKind === 'worktree') {
            if (hasWorktreeRemove && hasDelete) return [];
        } else if (hasCheckout && hasDelete) {
            return [];
        }

        this.currentBranch = execSync('git rev-parse --abbrev-ref HEAD', {
            cwd: ctx.workspaceRoot,
            encoding: 'utf8',
        }).trim();
        this.worktreePath = ctx.workspaceRoot;

        return [new V(1, truncate(ctx.command))];
    }
}
