import { execSync } from 'child_process';

import { BranchCreationGuardConfig } from '@webpieces/rules-config';

import type { BashContext, Violation } from '../types';
import { Violation as V } from '../types';
import { BashRuleBase } from '../rule-base';
import { FixHint, Option } from '../fix-hint';

// Defaults used when the rule has no explicit value in webpieces.config.json.
// branchFormat is a human sentence telling the AI how to name a branch created off main; it is
// intentionally NOT the sub-branch convention (sub-branches are a separate, human-approved path).
const DEFAULT_BRANCH_FORMAT =
    'Name it {whoami}/<short-feature-description> — lowercase, no version numbers, no sub/ prefix (e.g. dean/upgrade-webpieces)';
const DEFAULT_SUB_BRANCH_NAMING = 'feature/<ticket>/<short-description>';

const BRANCH_PATTERNS: RegExp[] = [
    /git\s+checkout\s+-[bB]\s+([^\s]+)/,
    /git\s+switch\s+-[cC]\s+([^\s]+)/,
    /git\s+branch\s+(?!-[dDmMrRla])([^\s-][^\s]*)/,
];

// The squash-merge tooling reserves a trailing `wp<number>` as its generation marker
// (base → basewp2 → basewp3). A human branch ending that way would collide with it, so
// block it at creation time and steer the name back to the plain feature form.
const RESERVED_GENERATION_SUFFIX = /wp\d+$/;

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

export class BranchCreationGuardRule extends BashRuleBase<BranchCreationGuardConfig> {
    constructor(config: BranchCreationGuardConfig) { super(config, 'branch-creation-guard'); }

    readonly description = 'Block new-branch creation when main is stale, or when branching off a non-main branch.';
    override readonly defaultOptions = {
        subBranchNaming: DEFAULT_SUB_BRANCH_NAMING,
        branchFormat: DEFAULT_BRANCH_FORMAT,
    };

    private get branchFormat(): string {
        return this.config.branchFormat ?? DEFAULT_BRANCH_FORMAT;
    }

    private get subBranchNaming(): string {
        return this.config.subBranchNaming ?? DEFAULT_SUB_BRANCH_NAMING;
    }

    // Mode-aware fix hints. Branches off main follow branchFormat — never the sub-branch
    // convention. The sub-branch affordance only appears under mode 'ON'; 'ON_NO_SUBBRANCHES'
    // hard-blocks it and points instead at the ignoreModifiedUntilEpoch escape hatch.
    get fixHint(): FixHint {
        const options = [
            new Option("Run 'git checkout main && git pull origin main', then create your branch FROM main", true),
            new Option(`Name a branch off main per branch-creation-guard.branchFormat: ${this.branchFormat}`),
        ];
        if (this.config.mode === 'ON_NO_SUBBRANCHES') {
            options.push(new Option(
                'Sub-branches (branching off another feature branch) are disabled. To temporarily allow one, set ' +
                "branch-creation-guard.ignoreModifiedUntilEpoch to a future epoch in webpieces.config.json",
            ));
        } else {
            options.push(new Option(
                `If you truly need a stacked sub-branch (requires human approval), name it per branch-creation-guard.subBranchNaming: ${this.subBranchNaming}`,
            ));
        }
        return new FixHint(
            'Cannot create this branch (main is stale, or branching off a non-main branch).',
            'Create your branch from an up-to-date main. Pick one:',
            options,
            undefined,
            true,
        );
    }

    check(ctx: BashContext): readonly Violation[] {
        const requestedName = extractBranchName(ctx.command);
        if (!requestedName) return [];

        if (RESERVED_GENERATION_SUFFIX.test(requestedName)) {
            return [new V(
                1,
                truncate(ctx.command),
                `Branch name '${requestedName}' ends in 'wp<number>', which is reserved for the ` +
                `squash-merge tool's generation marker (base → basewp2 → basewp3). ` +
                `Rename it to a plain feature branch. ${this.branchFormat}.`,
            )];
        }

        const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', {
            cwd: ctx.workspaceRoot,
            encoding: 'utf8',
        }).trim();

        if (currentBranch === 'main') {
            return checkMainIsUpToDate(ctx, requestedName);
        }

        // Not on main: creating this branch would stack it on a feature branch (a sub-branch).
        if (this.config.mode === 'ON_NO_SUBBRANCHES') {
            return [new V(
                1,
                truncate(ctx.command),
                `You are on '${currentBranch}', not main. You need to run ` +
                `git checkout main && git pull && git checkout -b ${requestedName} ` +
                `instead of branching from this branch!!! ${this.branchFormat}. ` +
                `You can temporarily turn this off if you truly need a sub-branch by setting ` +
                `branch-creation-guard.ignoreModifiedUntilEpoch (a future epoch) in webpieces.config.json.`,
            )];
        }

        return [new V(
            1,
            truncate(ctx.command),
            `You are on '${currentBranch}', not main. Branches must be created from main: ` +
            `git checkout main && git pull && git checkout -b ${requestedName}. ${this.branchFormat}. ` +
            `If you truly need a stacked sub-branch (requires human approval), name it per ` +
            `branch-creation-guard.subBranchNaming ('${this.subBranchNaming}').`,
        )];
    }
}
