import { execSync } from 'child_process';

import { RedirectHowToMergeMainConfig } from '@webpieces/rules-config';

import type { BashContext, Violation } from '../types';
import { Violation as V } from '../types';
import { BashRuleBase } from '../rule-base';
import { FixHint } from '../fix-hint';

const FIX_HINT = new FixHint(
    'Direct merge/rebase/pull from main on a feature branch is blocked.',
    "To bring main's changes into your feature branch, run 'pnpm wp-start-update' to squash-update from main — never `git merge/rebase/pull main`. This preserves the 3-point fork-point system (fork-point=A, feature-HEAD=B, main-HEAD=C) needed for clean PR diffs. See .webpieces/instruct-ai/webpieces.git-workflow.md for the full flow (incl. worktrees).\n"
    + 'Add that info to memory so you remember next time.',
);

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
            `Direct merge/rebase from main on branch '${currentBranch}' is blocked.`,
        )];
    }
}
