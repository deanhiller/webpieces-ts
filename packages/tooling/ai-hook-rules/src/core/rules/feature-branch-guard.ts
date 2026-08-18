import { execSync } from 'child_process';

import { BranchStateGuardConfig, BRANCH_STATE_GUARD_KEY, DEFAULT_HANG_TIMEOUT_MINUTES, readMainSyncStatus, squashRecoverySteps, MainSyncStatus, SyncFlowGuidance, Option } from '@webpieces/rules-config';

import type { FileContext, Violation } from '../types';
import { Violation as V } from '../types';
import { FileRuleBase } from '../rule-base';
import { FixHint } from '../fix-hint';
import { toError } from '../to-error';
import { triggerMainSyncRefresh } from '../main-sync-refresh';
import { hangTimeoutOf } from '../main-sync-timeout';
import { logGuardDecision, GuardDecision, Verdict, matrixL2Row } from '../decision-log';
import { writeBranchStateMatrixDoc, branchStateMatrixPointer } from '../l2-matrix-doc';
import { L0_FAULT_NONE } from '../l0-fault-codes';
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
export class FeatureBranchGuardRule extends FileRuleBase<BranchStateGuardConfig> {
    // NAME is this class's operator identity (every `rule=` in the log, every deny header);
    // CONFIG KEY is the one branch-state policy entry all four of these guards read. See AbstractRule.
    constructor(config: BranchStateGuardConfig) { super(config, 'feature-branch-guard', BRANCH_STATE_GUARD_KEY); }

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
            new Option('Disable in webpieces.config.json under hookGuards → branch-state-guard (mode OFF) if intentional — that one key governs the Write, Read and Bash halves of this policy together.'),
        ],
    );

    check(ctx: FileContext): readonly Violation[] {
        // Only files inside the workspace root — guard has no jurisdiction, nothing worth logging.
        if (ctx.relativePath.startsWith('..')) return [];

        const branch = this.currentBranch(ctx.workspaceRoot);
        // Can't determine branch (e.g. not a git repo) → don't block. Fail-open.
        if (branch === null) return this.failOpen(ctx, branch, 'branch-undeterminable');

        // State 1: on main — synchronous, no cache needed.
        if (branch === 'main') {
            return this.block(ctx, branch, 'on-main', this.onMainMessage());
        }

        // Keep the cache warm for the next call. Detached; never blocks this edit.
        triggerMainSyncRefresh(ctx.workspaceRoot, hangTimeoutOf(this.config));

        const status = readMainSyncStatus(ctx.workspaceRoot, branch);
        // No cache yet (first edit of the session) → allow; the refresh we just spawned populates it
        // for the next call. Fail-open: never block on missing data.
        if (status === null) return this.failOpen(ctx, branch, 'no-sync-cache', 'cache=none');

        const cache = this.cacheSummary(status);
        // BELT-AND-BRACES since the cache became branch-keyed: we looked this entry up BY `branch`, so
        // a mismatch now means the map's key and the entry's own `branch` field disagree — a shape bug,
        // not a normal state. Kept (rather than deleted) so such a bug degrades to an allow instead of
        // blocking on another branch's signals. Unreachable in normal operation.
        if (status.branch !== branch) return this.failOpen(ctx, branch, 'stale-cross-branch-cache', cache);

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
        // NOT-MERGED, or NOT-ASKED? `branchAlreadyMerged: false` is produced both by "this branch has
        // no merged PR" and by "the forge could not be reached" (`gh` missing, unauthenticated,
        // rate-limited, offline). Same allow either way — never block on data you could not establish
        // — but the LOG must not call the second one an approval, or the trail cannot tell a policy
        // that is protecting something from one that is quietly standing down.
        // Reached only when the branch is NOT merged, HAS a fork point and does NOT conflict. The
        // last two are pure git; only the first depends on the forge, which is why an unreachable
        // forge downgrades this to an abstention rather than leaving it a clean approval.
        if (!status.forgeReachable) return this.failOpen(ctx, branch, 'no-forge', cache);
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
    /**
     * The guard could not ESTABLISH the state it judges on, so it judged nothing.
     *
     * A sibling of allow() rather than a reason string passed to it, because the difference has to
     * reach the LOG as a value: `ALLOW_FAIL_OPEN` vs `ALLOW`. It was previously a `' (fail-open)'`
     * suffix on the free-text reason, which meant an abstention and a real approval were the same
     * verdict and the abstentions could not be counted — so nobody could tell whether these guards
     * were protecting anything or quietly standing down. Never block on data you could not
     * establish; but say out loud, in a field, that you did not establish it.
     */
    private failOpen(ctx: FileContext, branch: string | null, reason: string, cache: string = '-'): readonly Violation[] {
        this.logDecision(ctx, branch, 'ALLOW_FAIL_OPEN', reason, cache);
        return [];
    }

    private allow(ctx: FileContext, branch: string | null, reason: string, cache: string = '-'): readonly Violation[] {
        this.logDecision(ctx, branch, 'ALLOW', reason, cache);
        return [];
    }

    private block(ctx: FileContext, branch: string, reason: string, message: string, cache: string = '-'): readonly Violation[] {
        this.logDecision(ctx, branch, 'BLOCK_AI_CURE', reason, cache);
        // Deliver the matrix and name the row — see stale-main-bash-guard.block for why it is lazy.
        const pointer = branchStateMatrixPointer(writeBranchStateMatrixDoc(ctx.workspaceRoot), matrixL2Row(reason).row);
        return [new V(1, ctx.relativePath, message + pointer)];
    }

    private logDecision(ctx: FileContext, branch: string | null, verdict: Verdict, reason: string, cache: string): void {
        logGuardDecision(
            ctx.workspaceRoot,
            new GuardDecision('feature-branch-guard', ctx.tool, ctx.relativePath, branch ?? 'unknown', verdict, reason, cache, L0_FAULT_NONE, matrixL2Row(reason)),
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
        return new MergedBranchMessage(workspaceRoot).forEdits(
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
