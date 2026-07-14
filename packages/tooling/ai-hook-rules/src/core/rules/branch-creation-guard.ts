import { execSync } from 'child_process';

import {
    BranchCreationGuardConfig,
    DeletableBranch,
    DeletableWorktree,
    MergedBranchesCache,
    MergedBranchesService,
    WorktreeService,
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
//
// The branch cap counts PARKED branches only — branches not checked out in any worktree. Worktree-held
// branches are counted by the worktree cap instead. Two budgets, because they are not substitutes: if
// held branches also spent the branch budget, five worktrees would leave room for zero branches and no
// branch could ever be created again.
const DEFAULT_MAX_LOCAL_BRANCHES = 5;
const DEFAULT_MAX_WORKTREES = 5;

// A plausible git ref name. Deliberately NOT `[^\s-]` — that class matches shell metacharacters, so
// `git branch | wc -l` (a read-only LISTING, piped) was parsed as "create a branch named `|`" and
// blocked. Cleanup work necessarily reads and deletes branches, so a listing must never trip this.
const REF_NAME = String.raw`[A-Za-z0-9][A-Za-z0-9_./-]*`;

const BRANCH_PATTERNS: RegExp[] = [
    new RegExp(String.raw`git\s+checkout\s+-[bB]\s+(${REF_NAME})`),
    new RegExp(String.raw`git\s+switch\s+-[cC]\s+(${REF_NAME})`),
    new RegExp(String.raw`git\s+branch\s+(?!-)(${REF_NAME})`),
    // `git worktree add ../dir -b <name> origin/main` — the form docs/git-workflow.md recommends for
    // starting a feature. It creates a branch just as surely as `checkout -b` does, and until this
    // pattern existed it walked straight past the cap, the reserved-suffix check and the sub-branch
    // check. `(?:\S+\s+)*?` absorbs the path and any other flags, so the -b may precede or follow them.
    new RegExp(String.raw`git\s+worktree\s+add\s+(?:\S+\s+)*?-[bB]\s+(${REF_NAME})`),
];

// ANY worktree creation, with or without -b. The no-`-b` forms (`git worktree add ../dir existing`,
// `--detach`) create no branch but DO create a worktree, so they spend the worktree budget and must
// still hit the cap.
const WORKTREE_ADD = /git\s+worktree\s+add\b/;

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

// The worktree arm of the same allow: `git worktree add ../dir -b <name> origin/main`. Same fresh-main
// base, same reasoning — and in a worktree it is the ONLY workable base, since `git checkout main`
// fatals there. Kept separate from ORIGIN_MAIN_BASE because the argument shape differs (a path sits
// between the subcommand and the flags).
const WORKTREE_ORIGIN_MAIN_BASE = /git\s+worktree\s+add\s+(?:\S+\s+)*origin\/main(?:\W|$)/;

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
        'Block new-branch and new-worktree creation when main is stale, when branching off a non-main ' +
        'branch, or when the branch/worktree count is at its cap (forces cleanup of dead ones).';
    override readonly defaultOptions = {
        subBranchNaming: DEFAULT_SUB_BRANCH_NAMING,
        branchFormat: DEFAULT_BRANCH_FORMAT,
        maxLocalBranches: DEFAULT_MAX_LOCAL_BRANCHES,
        maxWorktrees: DEFAULT_MAX_WORKTREES,
    };

    private readonly worktrees = new WorktreeService();
    private readonly mergedBranches = new MergedBranchesService(this.worktrees);

    // Set by check() when (and only when) a cap is what blocked, so fixHint can render the reap
    // instructions instead of the branch-naming ones. Same instance-field handoff pr-merge-guard uses.
    // Two fields, because the two caps reap different things and their hints share no wording.
    private capCache: MergedBranchesCache | null = null;
    private worktreeCapCache: MergedBranchesCache | null = null;

    // True when the blocked command was a `git worktree add`, so the recovery command we hand back is
    // a worktree command and not a `git checkout -b` the user cannot use here.
    private worktreeAdd = false;

    private get branchFormat(): string {
        return this.config.branchFormat ?? DEFAULT_BRANCH_FORMAT;
    }

    private get subBranchNaming(): string {
        return this.config.subBranchNaming ?? DEFAULT_SUB_BRANCH_NAMING;
    }

    private get maxLocalBranches(): number {
        return this.config.maxLocalBranches ?? DEFAULT_MAX_LOCAL_BRANCHES;
    }

    private get maxWorktrees(): number {
        return this.config.maxWorktrees ?? DEFAULT_MAX_WORKTREES;
    }

    // The recovery command for "base this off fresh main", in the flavour of whatever was blocked.
    private freshMainCommand(name: string): string {
        return this.worktreeAdd
            ? `git fetch origin main && git worktree add ../${name.replace(/\//g, '-')} -b ${name} origin/main`
            : `git fetch origin main && git checkout -b ${name} origin/main`;
    }

    // Mode-aware fix hints. Branches off main follow branchFormat — never the sub-branch
    // convention. The sub-branch affordance only appears under mode 'ON'; 'ON_NO_SUBBRANCHES'
    // hard-blocks it and points instead at the ignoreModifiedUntilEpoch escape hatch.
    get fixHint(): FixHint {
        if (this.worktreeCapCache) return this.worktreeCapFixHint(this.worktreeCapCache);
        if (this.capCache) return this.capFixHint(this.capCache);

        const create = this.worktreeAdd
            ? 'Create it off fresh main: git fetch origin main && git worktree add ../<dir> -b <name> origin/main'
            : 'Create it off fresh main from anywhere (incl. a worktree): git fetch origin main && git checkout -b <name> origin/main';

        const options = [
            new Option(create, true),
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
        this.worktreeCapCache = null;
        // Match against the command with heredoc bodies and prose-in-quotes removed. A commit message
        // that merely MENTIONS a branch command is not a branch command.
        const command = this.stripNonCommandText(ctx.command);
        const requestedName = extractBranchName(command);
        this.worktreeAdd = WORKTREE_ADD.test(command);

        // A worktree add with no -b creates no branch, but it DOES spend the worktree budget, so it must
        // survive this early-out and reach the worktree cap below.
        if (!requestedName && !this.worktreeAdd) return [];

        if (requestedName && RESERVED_GENERATION_SUFFIX.test(requestedName)) {
            return [new V(
                1,
                truncate(ctx.command),
                `Branch name '${requestedName}' ends in 'wp<number>', which is reserved for the ` +
                `squash-merge tool's generation marker (base → basewp2 → basewp3). ` +
                `Rename it to a plain feature branch. ${this.branchFormat}.`,
            )];
        }

        const capViolation = this.checkCaps(ctx, requestedName !== null);
        if (capViolation) return [capViolation];

        // `git worktree add` of an EXISTING branch (or --detach) creates no branch: the cap above was the
        // only rule that applies to it. Nothing left to check.
        if (!requestedName) return [];

        // Explicitly basing off origin/main is always allowed — it creates the branch from fresh main
        // regardless of the current branch, and is the ONLY way that also works inside a linked worktree
        // (where `git checkout main` fatals). Reserved-name check above still applies.
        if (ORIGIN_MAIN_BASE.test(command)) return [];
        if (this.worktreeAdd && WORKTREE_ORIGIN_MAIN_BASE.test(command)) return [];

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
                `stacking it on this branch: ${this.freshMainCommand(requestedName)} ` +
                `(works here and inside a worktree). ${this.branchFormat}. ` +
                `You can temporarily turn this off if you truly need a sub-branch by setting ` +
                `branch-creation-guard.ignoreModifiedUntilEpoch (a future epoch) in webpieces.config.json.`,
            )];
        }

        return [new V(
            1,
            truncate(ctx.command),
            `You are on '${currentBranch}', not main. Branches must be created from fresh main: ` +
            `${this.freshMainCommand(requestedName)}. ${this.branchFormat}. ` +
            `If you truly need a stacked sub-branch (requires human approval), name it per ` +
            `branch-creation-guard.subBranchNaming ('${this.subBranchNaming}').`,
        )];
    }

    /**
     * Both budgets, in the order that produces the most useful complaint.
     *
     * Called BEFORE the origin/main allow in check() — `... -b <name> origin/main` is the normal,
     * always-permitted path, so a cap checked after it would never once fire.
     *
     * Worktree cap first: a `git worktree add -b` spends BOTH budgets, and when both are full the
     * worktree is the thing the command was actually trying to make, so it is the thing to talk about.
     */
    private checkCaps(ctx: BashContext, createsBranch: boolean): Violation | null {
        if (this.worktreeAdd) {
            const worktreeViolation = this.checkWorktreeCap(ctx);
            if (worktreeViolation) return worktreeViolation;
        }
        if (createsBranch) return this.checkBranchCap(ctx);
        return null;
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
        // PARKED branches only — a branch checked out in a worktree is the worktree cap's problem, and
        // counting it twice would let five worktrees exhaust the branch budget on their own.
        const held = this.worktrees.heldBranches(ctx.workspaceRoot);
        const parked = this.mergedBranches.localBranches(ctx.workspaceRoot)
            .filter((branch: string): boolean => !held.has(branch));
        const count = parked.length;
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
            `You have ${String(count)} parked local branches (not counting any checked out in a worktree); ` +
            `the cap (branch-creation-guard.maxLocalBranches) is ${String(this.maxLocalBranches)}. ` +
            `${detail} Clean up before creating another.`,
        );
    }

    /**
     * The worktree cap — the second budget. Same gate, same fail-open rule as the branch cap: a
     * worktree list we cannot classify (no cache on disk) blocks nothing.
     *
     * Counts LINKED worktrees only. The primary clone is not a thing anyone can remove, so charging the
     * budget for it would just silently cost you one worktree.
     */
    private checkWorktreeCap(ctx: BashContext): Violation | null {
        const count = this.worktrees.linkedWorktrees(ctx.workspaceRoot).length;
        if (count < this.maxWorktrees) return null;

        const cache = this.mergedBranches.readMergedBranches(ctx.workspaceRoot);
        if (!cache) return null;

        this.worktreeCapCache = cache;
        const reapable = cache.worktrees.filter((tree: DeletableWorktree): boolean => tree.deletable).length;
        const detail = reapable > 0
            ? `${String(reapable)} of them are dead (merged branch, no commits, or a missing directory) ` +
              'and can be removed right now.'
            : 'None of them are dead, so none can be auto-reaped — see the options below.';

        return new V(
            1,
            truncate(ctx.command),
            `You have ${String(count)} linked worktrees; the cap (branch-creation-guard.maxWorktrees) ` +
            `is ${String(this.maxWorktrees)}. ${detail} Clean up before creating another.`,
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

    /**
     * The worktree reap instructions.
     *
     * The command ORDER is load-bearing and is the whole reason this is generated rather than described:
     *   1. `git worktree prune` — clears the admin data of worktrees whose directory is already gone.
     *      `git worktree remove` FAILS on those, so it cannot be the first step.
     *   2. `git worktree remove <path>` — one path per invocation; git takes no path list here.
     *   3. `git branch -D <names>` — only now. git flatly refuses to delete a branch that is still
     *      checked out in a worktree, so a branch delete placed before the removal fails, and because
     *      it is one multi-name command it takes every other branch in the list down with it.
     */
    private worktreeCapFixHint(cache: MergedBranchesCache): FixHint {
        const options: Option[] = [];
        const dead = cache.worktrees.filter((tree: DeletableWorktree): boolean => tree.deletable);

        if (dead.length > 0) {
            const steps = ['git worktree prune'];
            for (const tree of dead) {
                // A prunable worktree has no directory left to remove — step 1 already handled it.
                if (tree.path !== '') steps.push(`git worktree remove ${tree.path}`);
            }
            const branches = dead
                .map((tree: DeletableWorktree): string => tree.branch)
                .filter((branch: string): boolean => branch !== '');
            if (branches.length > 0) steps.push(`git branch -D ${branches.join(' ')}`);

            options.push(new Option(
                `Remove these ${String(dead.length)} dead worktrees — each holds a branch backed by a MERGED ` +
                'PR, a branch with no commits of its own, or a directory that is already gone, so no work ' +
                'can be lost (see merged-branches.json for the per-worktree reason). Run it in this order ' +
                `(prune first, branches last — git refuses to delete a branch a worktree still holds): ${steps.join(' && ')}`,
                true,
            ));
        }

        options.push(new Option(
            'If you genuinely need more worktrees in flight, raise branch-creation-guard.maxWorktrees ' +
            'in webpieces.config.json.',
        ));
        options.push(new Option(
            'To bypass this once, set branch-creation-guard.ignoreModifiedUntilEpoch (a future epoch) ' +
            'in webpieces.config.json.',
        ));

        const spared = cache.worktrees.length - dead.length;
        const kept = spared > 0
            ? ` ${String(spared)} worktree(s) were deliberately SPARED (locked, holding unmerged work, or ` +
              'the one you are standing in) — do not remove those; a human decides.'
            : '';

        return new FixHint(
            'Too many worktrees — reap the dead ones before creating another.',
            'Full detail (deletable + spared, with per-worktree reasons) is in .webpieces/merged-branches.json, ' +
            `refreshed ${cache.timestamp || 'never'}.${kept} Pick one:`,
            options,
        );
    }
}
