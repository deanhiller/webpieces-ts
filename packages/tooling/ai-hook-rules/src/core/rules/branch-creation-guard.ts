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

// A trailing `wp<number>` was the old squash-merge generation marker (base → basewp2 → basewp3).
// The tooling NO LONGER produces it — a sync now lands back on the same feature name — but the suffix
// stays RESERVED so a human branch can't collide with a leftover `…wpN` still floating in a consumer
// repo mid-transition. Block it at creation time and steer the name back to the plain feature form.
const RESERVED_GENERATION_SUFFIX = /wp\d+$/;

// A branch-creation command that explicitly bases off origin/main (e.g. `git checkout -b feat
// origin/main`). This is exactly the fresh-main base the guard wants, and it works from ANY current
// branch or linked worktree — main need not (and in a worktree cannot) be checked out here. Allowed
// unconditionally so the recovery messages can safely tell you to run it from a worktree.
const ORIGIN_MAIN_BASE = /git\s+(?:checkout\s+-[bB]|switch\s+-[cC])\s+\S+\s+origin\/main(?:\s|$)/;

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
            new Option("Create it off fresh main from anywhere (incl. a worktree): git fetch origin main && git checkout -b <name> origin/main", true),
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

        // Explicitly basing off origin/main is always allowed — it creates the branch from fresh main
        // regardless of the current branch, and is the ONLY way that also works inside a linked worktree
        // (where `git checkout main` fatals). Reserved-name check above still applies.
        if (ORIGIN_MAIN_BASE.test(ctx.command)) return [];

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
                `You are on '${currentBranch}', not main. Create the branch OFF origin/main instead of ` +
                `stacking it on this branch: git fetch origin main && git checkout -b ${requestedName} origin/main ` +
                `(works here and inside a worktree). ${this.branchFormat}. ` +
                `You can temporarily turn this off if you truly need a sub-branch by setting ` +
                `branch-creation-guard.ignoreModifiedUntilEpoch (a future epoch) in webpieces.config.json.`,
            )];
        }

        return [new V(
            1,
            truncate(ctx.command),
            `You are on '${currentBranch}', not main. Branches must be created from fresh main: ` +
            `git fetch origin main && git checkout -b ${requestedName} origin/main. ${this.branchFormat}. ` +
            `If you truly need a stacked sub-branch (requires human approval), name it per ` +
            `branch-creation-guard.subBranchNaming ('${this.subBranchNaming}').`,
        )];
    }
}
