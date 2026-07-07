import { execSync } from 'child_process';

import {
    FeatureBranchGuardConfig,
    DEFAULT_HANG_TIMEOUT_MINUTES,
    readMainSyncStatus,
    squashRecoverySteps,
    MainSyncStatus,
} from '@webpieces/rules-config';

import type { FileContext, Violation } from '../types';
import { Violation as V } from '../types';
import { FileRuleBase } from '../rule-base';
import { FixHint, Option } from '../fix-hint';
import { toError } from '../to-error';
import { triggerMainSyncRefresh } from '../main-sync-refresh';
import { logGuardDecision, GuardDecision } from '../decision-log';

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
            new Option('main moved/conflicts (mid-work) → `pnpm wp-update-start` (merge), `/wp-merge` (resolve), `pnpm wp-update-end`. Have an OPEN PR? use `pnpm wp-start-upsert-pr` → `/wp-merge` → `pnpm wp-finish-upsert-pr`.'),
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
            return this.block(ctx, branch, `already-merged PR#${pr}`, this.alreadyMergedMessage(branch, status.mergedPr), cache);
        }
        // State 3: no fork point — main was merged into the branch.
        if (!status.hasForkPoint) {
            return this.block(ctx, branch, 'no-fork-point', this.noForkPointMessage(branch), cache);
        }
        // State 4: origin/main moved and touches files you changed.
        if (status.conflict) {
            return this.block(ctx, branch, 'main-moved-conflict', this.conflictMessage(status.conflictFiles), cache);
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

    private alreadyMergedMessage(branch: string, mergedPr: string): string {
        const pr = mergedPr !== '' ? ` (merged PR #${mergedPr})` : '';
        return [
            `It looks like you forgot to switch to main and delete this branch "${branch}" — its PR is already merged into main${pr}.`,
            'Your work is in main — do NOT keep editing this stale branch (you will reconflict with main).',
            'Start fresh:',
            '  1. git checkout main',
            '  2. git pull',
            '  3. git checkout -b <new-feature-branch>',
            'Please add to memory: switch to main (and delete the branch) after a PR is merged.',
        ].join('\n');
    }

    private conflictMessage(conflictFiles: readonly string[]): string {
        const files = conflictFiles.length > 0
            ? conflictFiles.map((f: string): string => `  - ${f}`).join('\n')
            : '  (see git diff)';
        return [
            'origin/main moved and touched files you also changed since your fork point:',
            files,
            '',
            'You must merge main in before editing further. If you are mid-work and just want to keep',
            'editing (no PR yet), use the UPDATE-ONLY flow:',
            '  1. pnpm wp-update-start   ← merges main (auto-finalizes if clean; renames <branch>wpN → wpN+1)',
            '  2. /wp-merge              ← resolve each conflicted file (only if there are conflicts)',
            '  3. pnpm wp-update-end     ← finalize the merge (only after resolving)',
            '',
            'If you already have an OPEN PR for this branch, use the PR flow instead (it updates the',
            "PR's pushed branch — wp-update-start does NOT push):",
            '  1. pnpm wp-start-upsert-pr   ← merges main + writes 3-point context',
            '  2. /wp-merge                 ← resolve each conflicted file',
            '  3. pnpm wp-finish-upsert-pr  ← validate, build, push, upsert the PR',
        ].join('\n');
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
