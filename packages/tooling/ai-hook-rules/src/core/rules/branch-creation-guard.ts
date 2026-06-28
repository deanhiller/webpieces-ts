import { execSync } from 'child_process';
import type { BashRule, BashContext, Violation } from '../types';
import { Violation as V, FieldSchema } from '../types';

const FIX_HINT: readonly string[] = [
    "Run 'git checkout main && git pull origin main', then create your branch from main",
    "If you truly need a sub-branch (requires human approval), name it using the convention in webpieces.config.json 'branch-creation-guard.subBranchNaming'",
];

const branchCreationGuard: BashRule = {
    name: 'branch-creation-guard',
    description: 'Block new-branch creation when main is stale, or when not on main.',
    scope: 'bash',
    files: [],
    defaultOptions: { subBranchNaming: 'feature/<ticket>/<short-description>' },
    configSchema: {
        subBranchNaming: new FieldSchema('string', 'Naming convention shown when human approves a sub-branch off a feature branch'),
    },
    fixHint: FIX_HINT,

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

        return [new V(
            1,
            truncate(ctx.command),
            `You are on '${currentBranch}', not main. Branches must be created from main.`,
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
