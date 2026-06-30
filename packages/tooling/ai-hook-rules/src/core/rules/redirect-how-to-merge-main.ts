import { execSync } from 'child_process';

import { RedirectHowToMergeMainConfig } from '@webpieces/rules-config';

import type { BashContext, Violation } from '../types';
import { Violation as V } from '../types';
import { BashRuleBase } from '../rule-base';

const FIX_HINT: readonly string[] = [
    "Run 'pnpm wp-git-update' to squash-update from main. This preserves the 3-point fork-point system (fork-point=A, feature-HEAD=B, main-HEAD=C) needed for clean PR diffs. See docs/git-workflow.md for details.",
];

const WRONG_UPDATE_PATTERNS: RegExp[] = [
    /git\s+merge\s+(origin\/main|main)\b/,
    /git\s+rebase\s+(origin\/main|main)\b/,
    /git\s+pull\s+origin\s+main\b/,
];

function truncate(s: string): string {
    const MAX = 120;
    return s.length <= MAX ? s : s.slice(0, MAX) + '…';
}

export class RedirectHowToMergeMainRule extends BashRuleBase<RedirectHowToMergeMainConfig> {
    constructor(config: RedirectHowToMergeMainConfig) { super(config, 'redirect-how-to-merge-main'); }

    readonly description = 'Block direct git merge/rebase/pull from main on feature branches. Use the squash-update process instead.';
    readonly fixHint = FIX_HINT;

    check(ctx: BashContext): readonly Violation[] {
        const matched = WRONG_UPDATE_PATTERNS.some((p: RegExp) => p.test(ctx.command));
        if (!matched) return [];

        // Allow 'git checkout main && git pull origin main' — switching to main first is the recommended workflow
        if (/git\s+(?:checkout|switch)\s+main\b/.test(ctx.command)) {
            return [];
        }

        const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', {
            cwd: ctx.workspaceRoot,
            encoding: 'utf8',
        }).trim();

        if (currentBranch === 'main') {
            return [];
        }

        return [new V(
            1,
            truncate(ctx.command),
            [
                `Direct merge/rebase from main on branch '${currentBranch}' is blocked.`,
                'This breaks the 3-point fork-point system.',
                'Use the squash-update process instead:',
                '  pnpm wp-git-update',
                'See docs/git-workflow.md for details.',
            ].join('\n'),
        )];
    }
}
