import { execSync, spawnSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { isAbsolute, join } from 'path';
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
    defaultOptions: { buildCommand: '', requireTextInPr: '' },
    fixHint: FIX_HINT,

    check(ctx: BashContext): readonly Violation[] {
        if (!/gh\s+pr\s+create/.test(ctx.command)) return [];

        execSync('git fetch origin main --quiet', { cwd: ctx.workspaceRoot, encoding: 'utf8' });

        // spawnSync is used here because exit code 1 means "not an ancestor" (not an error)
        const result = spawnSync(
            'git', ['merge-base', '--is-ancestor', 'origin/main', 'HEAD'],
            { cwd: ctx.workspaceRoot },
        );

        if (result.status !== 0) {
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
        }

        const buildCmd = ctx.options['buildCommand'] as string;
        const requireText = ctx.options['requireTextInPr'] as string;
        if (buildCmd && requireText) {
            const body = extractPrBody(ctx.command, ctx.workspaceRoot);
            if (body !== null && !body.includes(requireText)) {
                return [new V(
                    1,
                    truncate(ctx.command),
                    [
                        'PR body is missing the required CI confirmation.',
                        'Before creating a PR you must run:',
                        `  ${buildCmd}`,
                        'After it passes, add this exact phrase to your PR description:',
                        `  "${requireText}"`,
                    ].join('\n'),
                )];
            }
        }
        return [];
    },
};

function extractPrBody(command: string, workspaceRoot: string): string | null {
    const fileMatch = /--body-file\s+(\S+)/.exec(command);
    if (fileMatch) {
        const resolved = isAbsolute(fileMatch[1]) ? fileMatch[1] : join(workspaceRoot, fileMatch[1]);
        if (!existsSync(resolved)) return null;
        return readFileSync(resolved, 'utf8');
    }
    const doubleQuoteMatch = /--body\s+"((?:[^"\\]|\\.)*)"/.exec(command);
    if (doubleQuoteMatch) return doubleQuoteMatch[1];
    const singleQuoteMatch = /--body\s+'((?:[^'\\]|\\.)*)'/.exec(command);
    if (singleQuoteMatch) return singleQuoteMatch[1];
    return null;
}

function truncate(s: string): string {
    const MAX = 120;
    return s.length <= MAX ? s : s.slice(0, MAX) + '…';
}

export default prCreationGuard;
