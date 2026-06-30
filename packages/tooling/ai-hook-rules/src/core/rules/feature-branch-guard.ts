import { execSync } from 'child_process';

import {
    FeatureBranchGuardConfig,
    DEFAULT_HANG_TIMEOUT_MINUTES,
    readMainSyncStatus,
    squashRecoverySteps,
} from '@webpieces/rules-config';

import type { FileContext, Violation } from '../types';
import { Violation as V } from '../types';
import { FileRuleBase } from '../rule-base';
import { toError } from '../to-error';
import { triggerMainSyncRefresh } from '../main-sync-refresh';

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
    readonly fixHint = [
        'You must be on a clean, up-to-date feature branch to edit code.',
        'On main → create a feature branch. Already merged → branch off fresh main.',
        'main moved/conflicts → `pnpm wp-start-upsert-pr` (merge), `/wp-merge` (resolve), `pnpm wp-finish-upsert-pr`.',
        'Disable in webpieces.config.json under feature-branch-guard (mode OFF) if intentional.',
    ];

    check(ctx: FileContext): readonly Violation[] {
        // Only files inside the workspace root.
        if (ctx.relativePath.startsWith('..')) return [];

        const branch = this.currentBranch(ctx.workspaceRoot);
        if (branch === null) return []; // can't determine branch (e.g. not a git repo) → don't block

        // State 1: on main — synchronous, no cache needed.
        if (branch === 'main') {
            return [new V(1, ctx.relativePath, this.onMainMessage())];
        }

        // Keep the cache warm for the next call. Detached; never blocks this edit.
        triggerMainSyncRefresh(ctx.workspaceRoot, this.config.hangTimeoutMinutes ?? DEFAULT_HANG_TIMEOUT_MINUTES);

        const status = readMainSyncStatus(ctx.workspaceRoot);
        // No cache yet (first edit of the session) → allow; the refresh we just spawned populates it
        // for the next call. Fail-open: never block on missing data.
        if (status === null) return [];

        // State 2: this feature branch was already merged into main.
        if (status.branchAlreadyMerged) {
            return [new V(1, ctx.relativePath, this.alreadyMergedMessage(branch, status.mergedPr))];
        }
        // State 3: no fork point — main was merged into the branch.
        if (!status.hasForkPoint) {
            return [new V(1, ctx.relativePath, this.noForkPointMessage(branch))];
        }
        // State 4: origin/main moved and touches files you changed.
        if (status.conflict) {
            return [new V(1, ctx.relativePath, this.conflictMessage(status.conflictFiles))];
        }
        return [];
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
            `This feature branch "${branch}" was already merged into main${pr}.`,
            'Your work is in main — do NOT keep editing this stale branch (you will reconflict with main).',
            'Start fresh:',
            '  1. git checkout main',
            '  2. git pull',
            '  3. git checkout -b <new-feature-branch>',
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
            'Merge main in before editing further:',
            '  1. pnpm wp-start-upsert-pr   ← merges main, writes 3-point conflict context',
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
