import { execSync } from 'child_process';

import {
    BranchCreationGuardConfig,
    DeletableBranch,
    MergedBranchesCache,
    MergedBranchesService,
} from '@webpieces/rules-config';

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

// Hard cap on local feature branches. Enforced at CREATION because that is the one moment cleanup is
// both cheap and obviously worth it — reaping happens over time, never "ASAP".
const DEFAULT_MAX_LOCAL_BRANCHES = 5;

// A plausible git ref name. Deliberately NOT `[^\s-]` — that class matches shell metacharacters, so
// `git branch | wc -l` (a read-only LISTING, piped) was parsed as "create a branch named `|`" and
// blocked. Cleanup work necessarily reads and deletes branches, so a listing must never trip this.
const REF_NAME = String.raw`[A-Za-z0-9][A-Za-z0-9_./-]*`;

const BRANCH_PATTERNS: RegExp[] = [
    new RegExp(String.raw`git\s+checkout\s+-[bB]\s+(${REF_NAME})`),
    new RegExp(String.raw`git\s+switch\s+-[cC]\s+(${REF_NAME})`),
    new RegExp(String.raw`git\s+branch\s+(?!-)(${REF_NAME})`),
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
//
// The trailing check is `\W|$`, not `\s|$`: the ALLOW pattern must not be stricter about delimiters
// than the BLOCK pattern above, or a `git checkout -b x origin/main` that ends at a quote or backtick
// is seen as a branch creation but NOT as an origin/main one — recognised, then wrongly blocked.
const ORIGIN_MAIN_BASE = /git\s+(?:checkout\s+-[bB]|switch\s+-[cC])\s+\S+\s+origin\/main(?:\W|$)/;

// Heredoc bodies: `<<EOF … \nEOF` / `<<-'EOF' … \nEOF`. Their content is DATA (a commit message, a
// file being written), never a command.
const HEREDOC_BODY = /<<-?\s*(['"]?)(\w+)\1[\s\S]*?^\t*\2\s*$/gm;

// A single- or double-quoted span.
const QUOTED_SPAN = /'([^']*)'|"([^"]*)"/g;

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

    readonly description =
        'Block new-branch creation when main is stale, when branching off a non-main branch, ' +
        'or when the local branch count is at its cap (forces cleanup of already-merged branches).';
    override readonly defaultOptions = {
        subBranchNaming: DEFAULT_SUB_BRANCH_NAMING,
        branchFormat: DEFAULT_BRANCH_FORMAT,
        maxLocalBranches: DEFAULT_MAX_LOCAL_BRANCHES,
    };

    private readonly mergedBranches = new MergedBranchesService();

    // Set by check() when (and only when) the cap is what blocked, so fixHint can render the reap
    // instructions instead of the branch-naming ones. Same instance-field handoff pr-merge-guard uses.
    private capCache: MergedBranchesCache | null = null;

    private get branchFormat(): string {
        return this.config.branchFormat ?? DEFAULT_BRANCH_FORMAT;
    }

    private get subBranchNaming(): string {
        return this.config.subBranchNaming ?? DEFAULT_SUB_BRANCH_NAMING;
    }

    private get maxLocalBranches(): number {
        return this.config.maxLocalBranches ?? DEFAULT_MAX_LOCAL_BRANCHES;
    }

    // Mode-aware fix hints. Branches off main follow branchFormat — never the sub-branch
    // convention. The sub-branch affordance only appears under mode 'ON'; 'ON_NO_SUBBRANCHES'
    // hard-blocks it and points instead at the ignoreModifiedUntilEpoch escape hatch.
    get fixHint(): FixHint {
        if (this.capCache) return this.capFixHint(this.capCache);

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

    /**
     * Strip the parts of a shell command that are DATA rather than executable commands, so the guard
     * stops reading prose as instructions.
     *
     * This guard regex-scans the raw command string and has no notion of quoting, so
     * `git commit -m "... git checkout -b foo ..."` — or any heredoc commit message that mentions a
     * branch command — was parsed as an actual branch creation and blocked. That bit three separate
     * times while building the branch cap, including on the cap's own commit. It matters far more now
     * that the cap check runs BEFORE the origin/main allow: at the cap, a merely-MENTIONED branch
     * command would block your commit.
     *
     * A quoted span whose content has no whitespace is kept verbatim (it is a single token — the name
     * in `git checkout -b "dean/foo"`), so quoting a branch name cannot smuggle a creation past the
     * guard. Anything with whitespace inside quotes is prose, and collapses to a space.
     */
    private stripNonCommandText(command: string): string {
        const withoutHeredocs = command.replace(HEREDOC_BODY, ' ');
        return withoutHeredocs.replace(QUOTED_SPAN, (match: string, single?: string, double?: string): string => {
            const content = single ?? double ?? '';
            return /\s/.test(content) ? ' ' : content;
        });
    }

    check(ctx: BashContext): readonly Violation[] {
        this.capCache = null;
        // Match against the command with heredoc bodies and prose-in-quotes removed. A commit message
        // that merely MENTIONS a branch command is not a branch command.
        const command = this.stripNonCommandText(ctx.command);
        const requestedName = extractBranchName(command);
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

        // The cap is checked BEFORE the origin/main allow below — `git checkout -b <name> origin/main`
        // is the normal, always-permitted path, so a cap check placed after it would never once fire.
        const capViolation = this.checkBranchCap(ctx);
        if (capViolation) return [capViolation];

        // Explicitly basing off origin/main is always allowed — it creates the branch from fresh main
        // regardless of the current branch, and is the ONLY way that also works inside a linked worktree
        // (where `git checkout main` fatals). Reserved-name check above still applies.
        if (ORIGIN_MAIN_BASE.test(command)) return [];

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

    /**
     * The cap. Blocks branch #N+1 until already-merged branches are reaped, which is the ONLY thing
     * keeping the local branch list bounded.
     *
     * Fails OPEN when the cache is absent (fresh clone, `gh` unavailable, refresher hasn't run yet):
     * never block on data we don't have. The detached refresher regenerates it within one hook call,
     * so the cap starts enforcing on its own.
     */
    private checkBranchCap(ctx: BashContext): Violation | null {
        const count = this.mergedBranches.localBranches(ctx.workspaceRoot).length;
        if (count < this.maxLocalBranches) return null;

        const cache = this.mergedBranches.readMergedBranches(ctx.workspaceRoot);
        if (!cache) return null;

        this.capCache = cache;
        const reapable = cache.deletable.length;
        const detail = reapable > 0
            ? `${String(reapable)} of them are dead (merged, or holding no commits) and can be deleted right now.`
            : 'None of them are dead, so none can be auto-reaped — see the options below.';

        return new V(
            1,
            truncate(ctx.command),
            `You have ${String(count)} local branches; the cap (branch-creation-guard.maxLocalBranches) ` +
            `is ${String(this.maxLocalBranches)}. ${detail} Clean up before creating another.`,
        );
    }

    /**
     * The reap instructions. `deletable` is PRECOMPUTED in the cache, and every entry earned its place
     * by one of exactly two proofs: a MERGED PR (the work is in main), or zero commits of its own
     * (there is no work). Deleting the list cannot lose anything — so just run the command.
     *
     * The wording must not overstate that: the list is NOT uniformly "merged PR" branches, and a
     * message that tells an agent to run `git branch -D` has to be exactly true about why that's safe.
     */
    private capFixHint(cache: MergedBranchesCache): FixHint {
        const options: Option[] = [];

        if (cache.deletable.length > 0) {
            const names = cache.deletable.map((entry: DeletableBranch): string => entry.branch);
            options.push(new Option(
                `Delete these ${String(names.length)} dead branches — each is either backed by a MERGED PR ` +
                `or has no commits of its own, so no work can be lost (see merged-branches.json for the ` +
                `per-branch reason): git branch -D ${names.join(' ')}`,
                true,
            ));
        }

        options.push(new Option(
            'If you genuinely need more branches in flight, raise branch-creation-guard.maxLocalBranches ' +
            'in webpieces.config.json.',
        ));
        options.push(new Option(
            'To bypass this once, set branch-creation-guard.ignoreModifiedUntilEpoch (a future epoch) ' +
            'in webpieces.config.json.',
        ));

        const kept = cache.keep.length > 0
            ? ` ${String(cache.keep.length)} unmerged branch(es) with real commits were deliberately SPARED — ` +
              'do not delete those; a human decides.'
            : '';

        return new FixHint(
            'Too many local branches — reap the dead ones before creating another.',
            'Full detail (deletable + spared, with per-branch reasons) is in .webpieces/merged-branches.json, ' +
            `refreshed ${cache.timestamp || 'never'}.${kept} Pick one:`,
            options,
        );
    }
}
