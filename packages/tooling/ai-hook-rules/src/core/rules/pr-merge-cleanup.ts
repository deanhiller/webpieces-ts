import { execSync } from 'child_process';

import { PrMergeCleanupConfig } from '@webpieces/rules-config';

import type { BashContext, Violation } from '../types';
import { Violation as V } from '../types';
import { BashRuleBase } from '../rule-base';

function truncate(s: string): string {
    const MAX = 120;
    return s.length <= MAX ? s : s.slice(0, MAX) + '…';
}

export class PrMergeCleanupRule extends BashRuleBase<PrMergeCleanupConfig> {
    constructor(config: PrMergeCleanupConfig) { super(config, 'pr-merge-cleanup'); }

    readonly description = 'After merging a PR, require switching to main, pulling, and deleting the local branch.';
    readonly fixHint = [
        'After merging a PR you must clean up the local branch.',
        'Run this combined command instead:',
        '  gh pr merge --squash && git checkout main && git pull && git branch -d <current-branch>',
    ];

    check(ctx: BashContext): readonly Violation[] {
        if (!/gh\s+pr\s+merge/.test(ctx.command)) return [];

        const hasCheckout = /git\s+(checkout|switch)\s+main/.test(ctx.command);
        const hasDelete = /git\s+branch\s+-[dD]/.test(ctx.command);

        if (hasCheckout && hasDelete) return [];

        const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', {
            cwd: ctx.workspaceRoot,
            encoding: 'utf8',
        }).trim();

        return [new V(
            1,
            truncate(ctx.command),
            [
                '[pr-merge-cleanup] After merging a PR you must clean up the local branch.',
                'Run this combined command instead:',
                `  gh pr merge --squash && git checkout main && git pull && git branch -d ${currentBranch}`,
            ].join('\n'),
        )];
    }
}
