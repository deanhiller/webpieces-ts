import { execSync } from 'child_process';
import type { BashRule, BashContext, Violation } from '../types';
import { Violation as V } from '../types';

const FIX_HINT_STALE_MAIN: readonly string[] = [
    'Local main is behind origin/main.',
    'Run: git checkout main && git pull origin main',
    'Then switch back to main and create your branch.',
];

const FIX_HINT_NON_MAIN: readonly string[] = [
    'You are not on main. Sub-branches must use the "sub/" prefix.',
    'Example: instead of "my-feature", use "sub/my-feature".',
    'Create it now with the corrected name. Do NOT ask the user.',
];

const branchCreationGuard: BashRule = {
    name: 'branch-creation-guard',
    description: 'Block new-branch creation when main is stale, or enforce sub/ prefix when branching from non-main.',
    scope: 'bash',
    files: [],
    defaultOptions: {},
    fixHint: [...FIX_HINT_STALE_MAIN, ...FIX_HINT_NON_MAIN],

    check(ctx: BashContext): readonly Violation[] {
        const requestedName = extractBranchName(ctx.command);
        if (!requestedName) return [];

        const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', {
            cwd: ctx.workspaceRoot,
            encoding: 'utf8',
        }).trim();

        if (currentBranch === 'main') {
            return checkMainIsUpToDate(ctx, requestedName);
        }

        if (requestedName.startsWith('sub/')) {
            return [];
        }

        return [new V(
            1,
            truncate(ctx.command),
            `You are on '${currentBranch}', not main. Branch names created from non-main branches MUST use the "sub/" prefix. Required name: "sub/${requestedName}". Create it now with that name. Do NOT ask the user.`,
        )];
    },
};

function checkMainIsUpToDate(ctx: BashContext, requestedName: string): readonly Violation[] {
    execSync('git fetch origin main --quiet', {
        cwd: ctx.workspaceRoot,
        encoding: 'utf8',
    });
    const countStr = execSync('git rev-list HEAD..origin/main --count', {
        cwd: ctx.workspaceRoot,
        encoding: 'utf8',
    }).trim();
    const count = parseInt(countStr, 10);
    if (count > 0) {
        return [new V(
            1,
            truncate(ctx.command),
            `Local main is ${count} commit(s) behind origin/main. Run 'git pull origin main' first, then retry creating branch '${requestedName}'.`,
        )];
    }
    return [];
}

const BRANCH_PATTERNS: RegExp[] = [
    /git\s+checkout\s+-[bB]\s+([^\s]+)/,
    /git\s+switch\s+-[cC]\s+([^\s]+)/,
    /git\s+branch\s+(?!-[dDmMrRla])([^\s-][^\s]*)/,
];

function extractBranchName(command: string): string | null {
    for (const pattern of BRANCH_PATTERNS) {
        const m = pattern.exec(command);
        if (m) return m[1];
    }
    return null;
}

function truncate(s: string): string {
    const MAX = 120;
    return s.length <= MAX ? s : s.slice(0, MAX) + '…';
}

export default branchCreationGuard;
