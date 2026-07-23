import { execSync } from 'child_process';

import {
    FeatureBranchGuardConfig,
    DEFAULT_HANG_TIMEOUT_MINUTES,
    readMainSyncStatus,
    squashRecoverySteps,
    MainSyncStatus,
    SyncFlowGuidance,
} from '@webpieces/rules-config';

import type { FileContext, Violation } from '../types';
import { Violation as V } from '../types';
import { FileRuleBase } from '../rule-base';
import { FixHint, Option } from '../fix-hint';
import { toError } from '../to-error';
import { triggerMainSyncRefresh } from '../main-sync-refresh';
import { logGuardDecision, GuardDecision } from '../decision-log';
import { MergedBranchMessage } from './merged-branch-message';
import { TreeRecovery } from './tree-recovery';

/**
 * Comprehensive "are you on a proper feature branch?" guard — the single rule that blocks edits when
 * the branch isn't a healthy place to work. Four states, in priority order:
 *   1. On main (checked SYNCHRONOUSLY here)          → block: create a feature branch.
 *   2. Branch already merged into main (merged PR)   → block: your work is in main, branch off fresh.
 *   3. No fork point with origin/main                → block: squash onto a new branch.
 *   4. origin/main moved & touches your files        → block: merge main first.
 * States 2–4 are PRECOMPUTED into `.webpieces/main-sync-status.json` by the detached refresher, so
 * this check does NO network git (only a fast local `git rev-parse` for state 1). On every call it
 * fire-and-forget spawns the refresher so the NEXT call is fresh. Runs in the GUARDS hook (it's a
 * hookGuard); file-scoped, so only Write/Edit/MultiEdit are guarded — Bash passes through so the AI
 * can still run `pnpm wp-start-upsert-pr` and the rest of the recovery flow.
 */
export class FeatureBranchGuardRule extends FileRuleBase<FeatureBranchGuardConfig> {
    constructor(config: FeatureBranchGuardConfig) { super(config, 'feature-branch-guard'); }

    readonly description = 'Block edits unless you are on a proper feature branch (not main, not already-merged, forked, in sync with main).';
    override readonly files = ['**/*'];
    override readonly defaultOptions = {
        branchNamingConvention: '{whoami}/{featurename}',
        hangTimeoutMinutes: DEFAULT_HANG_TIMEOUT_MINUTES,
    };
    readonly fixHint = new FixHint(
        'You are not on a clean, up-to-date feature branch.',
        'You must be on a clean, up-to-date feature branch to edit code. Pick one:',
        [
            new Option('On main → create a feature branch. Already merged → branch off fresh main.', true),
            new Option('main moved/conflicts, NO PR yet → `pnpm wp-start-update` (merge), `/wp-merge` (resolve), `pnpm wp-finish-update`. An OPEN PR? then you MUST use `pnpm wp-start-upsert-pr` → `/wp-merge` → `pnpm wp-finish-upsert-pr` (the merge rewrites the branch, so the PR must be re-pointed in the same run). Never mix a start from one pair with a finish from the other.'),
            new Option('Disable in webpieces.config.json under feature-branch-guard (mode OFF) if intentional.'),
        ],
    );

    check(ctx: FileContext): readonly Violation[] {
        // Only files inside the workspace root — guard has no jurisdiction, nothing worth logging.
        if (ctx.relativePath.startsWith('..')) return [];

        const branch = this.currentBranch(ctx.workspaceRoot);
        // Can't determine branch (e.g. not a git repo) → don't block. Fail-open.
        if (branch === null) return this.allow(ctx, branch, 'branch-undeterminable (fail-open)');

        // State 1: on main — synchronous, no cache needed.
        if (branch === 'main') {
            return this.block(ctx, branch, 'on-main', this.onMainMessage());
        }

        // Keep the cache warm for the next call. Detached; never blocks this edit.
        triggerMainSyncRefresh(ctx.workspaceRoot, this.config.hangTimeoutMinutes ?? DEFAULT_HANG_TIMEOUT_MINUTES);

        const status = readMainSyncStatus(ctx.workspaceRoot);
        // No cache yet (first edit of the session) → allow; the refresh we just spawned populates it
        // for the next call. Fail-open: never block on missing data.
        if (status === null) return this.allow(ctx, branch, 'no-sync-cache (fail-open)', 'cache=none');

        const cache = this.cacheSummary(status);
        // Stale cross-branch cache: the cached status is for a DIFFERENT branch (e.g. you just
        // switched branches and the refresh for this one hasn't landed yet). Never block on another
        // branch's signals — fail open; the refresh we just spawned rewrites it for this branch.
        if (status.branch !== branch) return this.allow(ctx, branch, 'stale-cross-branch-cache (fail-open)', cache);

        // State 2: this feature branch was already merged into main.
        if (status.branchAlreadyMerged) {
            const pr = status.mergedPr !== '' ? status.mergedPr : '?';
            const merged = this.alreadyMergedMessage(ctx.workspaceRoot, branch, status.mergedPr);
            return this.block(ctx, branch, `already-merged PR#${pr}`, merged, cache);
        }
        // State 3: no fork point — main was merged into the branch.
        if (!status.hasForkPoint) {
            return this.block(ctx, branch, 'no-fork-point', this.noForkPointMessage(branch), cache);
        }
        // State 4: origin/main moved and touches files you changed.
        if (status.conflict) {
            return this.block(ctx, branch, 'main-moved-conflict', this.conflictMessage(status.conflictFiles, status.openPr), cache);
        }
        return this.allow(ctx, branch, 'clean-feature-branch', cache);
    }

    // One-line summary of the async-written cache that drove this decision, for the SYNC log — so a
    // wrong allow/block is traceable to the exact (possibly stale) main-sync-status.json read.
    private cacheSummary(status: MainSyncStatus): string {
        const merged = status.branchAlreadyMerged ? `PR#${status.mergedPr !== '' ? status.mergedPr : '?'}` : 'no';
        return `cache=${status.branch} merged=${merged} fork=${String(status.hasForkPoint)} conflict=${String(status.conflict)} ts=${status.timestamp}`;
    }

    // Log + return for the allow path. Centralizes the decision-log call so every exit of check()
    // is recorded with its reason + the async cache it read (this is the audit trail for "why didn't
    // the guard fire?"). `cache` is the summary of the main-sync-status.json that drove the decision.
    private allow(ctx: FileContext, branch: string | null, reason: string, cache: string = '-'): readonly Violation[] {
        this.logDecision(ctx, branch, 'ALLOW', reason, cache);
        return [];
    }

    private block(ctx: FileContext, branch: string, reason: string, message: string, cache: string = '-'): readonly Violation[] {
        this.logDecision(ctx, branch, 'BLOCK', reason, cache);
        return [new V(1, ctx.relativePath, message)];
    }

    private logDecision(ctx: FileContext, branch: string | null, verdict: 'ALLOW' | 'BLOCK', reason: string, cache: string): void {
        logGuardDecision(
            ctx.workspaceRoot,
            new GuardDecision('feature-branch-guard', ctx.tool, ctx.relativePath, branch ?? 'unknown', verdict, reason, cache),
        );
    }

    private currentBranch(workspaceRoot: string): string | null {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            return execSync('git rev-parse --abbrev-ref HEAD', {
                cwd: workspaceRoot,
                encoding: 'utf8',
                stdio: ['pipe', 'pipe', 'pipe'],
            }).trim();
        } catch (err: unknown) {
            const error = toError(err);
            void error;
            return null;
        }
    }

    private onMainMessage(): string {
        const convention = this.config.branchNamingConvention ?? '{whoami}/{featurename}';
        return [
            'You should not be working on main.',
            'Do a `git pull origin main` to get latest, then create a feature branch based on the naming convention.',
            `Branch naming convention (from webpieces.config.json): ${convention}`,
            'Example: git checkout -b ' + convention.replace(/<[^>]+>/g, 'value'),
        ].join('\n');
    }

    // Shared with read-stale-guard, which blocks READS in this same state — see MergedBranchMessage.
    // The tree kind picks the flavour of the cure: a dead LINKED WORKTREE is told to open a new
    // worktree off origin/main and reap this one; the primary clone is told to branch off origin/main.
    private alreadyMergedMessage(workspaceRoot: string, branch: string, mergedPr: string): string {
        return new MergedBranchMessage().forEdits(
            branch, mergedPr, new TreeRecovery().kindOf(workspaceRoot), workspaceRoot,
        );
    }

    private conflictMessage(conflictFiles: readonly string[], openPr: string): string {
        const files = conflictFiles.length > 0
            ? conflictFiles.map((f: string): string => `  - ${f}`).join('\n')
            : '  (see git diff)';
        const header = [
            'origin/main moved and touched files you also changed since your fork point:',
            files,
            '',
        ];
        // Steer EARLY: if a PR already tracks this branch, the update-only flow would just fail-fast
        // (a 3-point update strands the PR on the old branch generation), so recommend ONLY the PR
        // flow and don't waste the AI's tokens on wp-start-update.
        const guidance = new SyncFlowGuidance();
        // An OPEN PR removes the choice, so print ONLY the PR flow here — showing the update-only flow
        // as if it were an option just burns tokens on a command that fail-fasts.
        if (openPr !== '') {
            return header
                .concat([
                    `An OPEN PR (#${openPr}) already tracks this branch, so the PR flow is the ONLY option`,
                    'here — it re-merges main AND re-points the PR in the same run:',
                    '',
                ])
                .concat(guidance.prFlow())
                .concat(['', ...guidance.whyPrForcesFlowB()])
                .join('\n');
        }
        return header
            .concat([
                'You must merge main in before editing further. No PR is open for this branch, so flow A',
                'below is the one to use — but use flow B the moment a PR exists:',
                '',
            ])
            .concat(guidance.flows())
            .join('\n');
    }

    private noForkPointMessage(branch: string): string {
        return [
            'No fork point with origin/main — main appears to have been merged into this branch,',
            'so a clean squash-merge is impossible. A human must redo the work on a fresh branch:',
            '',
            ...squashRecoverySteps(branch),
        ].join('\n');
    }
}
