import { execSync, spawnSync } from 'child_process';
import type { BashRule, BashContext, Violation } from '../types';
import { Violation as V } from '../types';

const FIX_HINT: readonly string[] = [
    'Branch is not up-to-date with origin/main.',
    'Run the squash-update process to sync with main first:',
    '  ./scripts/git-updateFromMain.sh',
    'Then retry: gh pr create ...',
    '',
    'Do NOT use "git merge origin/main" or "git rebase" — these break the 3-point fork-point system.',
    'See docs/git-workflow.md for the full squash-merge update process.',
];

const prCreationGuard: BashRule = {
    name: 'pr-creation-guard',
    description: 'Block PR creation when the branch has not been updated from origin/main via the squash-merge process.',
    scope: 'bash',
    files: [],
    defaultOptions: {},
    fixHint: FIX_HINT,

    check(ctx: BashContext): readonly Violation[] {
        if (!/gh\s+pr\s+create/.test(ctx.command)) return [];

        execSync('git fetch origin main --quiet', { cwd: ctx.workspaceRoot, encoding: 'utf8' });

        // spawnSync is used here because exit code 1 means "not an ancestor" (not an error)
        const result = spawnSync(
            'git', ['merge-base', '--is-ancestor', 'origin/main', 'HEAD'],
            { cwd: ctx.workspaceRoot },
        );
        if (result.status === 0) return [];

        return [new V(
            1,
            truncate(ctx.command),
            [
                'Branch is not up-to-date with origin/main.',
                'Run the squash-update process first:',
                '  ./scripts/git-updateFromMain.sh',
                'Do NOT use "git merge origin/main" or "git rebase" — these break the 3-point fork-point system.',
                'See docs/git-workflow.md for details.',
                'Then retry: gh pr create',
            ].join('\n'),
        )];
    },
};

function truncate(s: string): string {
    const MAX = 120;
    return s.length <= MAX ? s : s.slice(0, MAX) + '…';
}

export default prCreationGuard;
