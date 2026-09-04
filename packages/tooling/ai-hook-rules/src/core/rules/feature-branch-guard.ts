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
import { TargetTreeResolver } from '../target-tree';
import { MergedBranchMessage } from './merged-branch-message';
import { JudgedTree } from './judged-tree';
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
 *
 * ── STATE 1 IS UNCONDITIONAL, AND `B` NO LONGER TRACKS `E` HERE ──────────────────────────────────
 *
 * Earlier docblocks in this family argued that the Bash half of "on `main`" should match this one
 * exactly — one `git rev-parse`, no cache, so it fires on the first call of a session. That argument
 * has been split, deliberately, and the two halves now differ:
 *
 *   `E` (here)                 blocks on ANY `main`, current or stale.
 *   `B` (stale-main-bash-guard) blocks only once local `main` is KNOWN BEHIND `origin/main`.
 *
 * The hazards are not the same hazard. A WRITE on `main` puts work where it cannot be reviewed, cannot
 * be reverted as a unit, and is one `git checkout` from being lost — none of which depends on how
 * current `main` is, so nothing about freshness could make this block right or wrong. A READ or a
 * BUILD on a CURRENT `main` harms nothing at all, and denying it strands the agent immediately after
 * `pnpm wp-sync-main` — the very command this repo prescribes — put it there.
 *
 * So do NOT "restore the symmetry" by gating this on the cache. That would make writes on `main`
 * permitted for the whole first call of every session (the cache is populated for the NEXT call), and
 * permanently in a multi-worktree repo where another tree can hold the refresh lock. That ordering is
 * the most load-bearing thing in the L2 table, which is why row 5 sits ABOVE the cache divider.
 *
 * ── WHICH TREE IS JUDGED: THE ONE THAT OWNS THE FILE, NEVER THE ONE THE SESSION SITS IN ─────────────
 *
 * Every state above is a property of A BRANCH IN A CHECKOUT, so the first question this guard answers is
 * WHICH checkout — and the answer comes from the TARGET PATH, through TargetTreeResolver, which is
 * EffectiveTreeResolver asked about a file instead of a cwd. It is emphatically NOT `ctx.workspaceRoot`:
 * that is the walk-up from the session's cwd to the governing `webpieces.config.json`, and for a
 * main-session edit into an agent worktree it names the PRIMARY clone.
 *
 * Issue #851 is the incident. Claude Code checks a worktree out INSIDE the repo at
 * `<repo>/.claude/worktrees/agent-XXXX`, so a containment test answers "primary" for a path that is
 * plainly the worktree's. This guard then read the branch-keyed main-sync cache under the PRIMARY's
 * branch and enforced that verdict on a file belonging to a clean branch in another tree. The cache was
 * not stale and was not wrong — the correct entry sat in the same JSON file, one key over. Only the
 * lookup key was. Four tool calls were refused, including the `review.json` that `wp-review-upsert-pr`
 * requires before `wp-finish-upsert-pr` will open a PR, which is the shape where this wedges the
 * sanctioned flow rather than merely annoying somebody.
 *
 * Two consequences worth stating out loud, because both were argued the other way at some point:
 *
 *   - The DENY NAMES THE TREE (JudgedTree.header) and, when the judged tree is not the session's, the
 *     `pnpm --dir=<tree>` form of the cure. A resolution nobody can see is a resolution nobody can
 *     contradict, and the printed cure was measurably a no-op for the tree it was aimed at.
 *   - DETACHED HEAD in the target tree fails OPEN, logged. There is no branch name, so there is no map
 *     key and nothing to judge — matrix row 14. It used to reach here as the literal branch `HEAD`, miss
 *     in the cache and fail open as `no-sync-cache`, which is the right verdict recorded under a reason
 *     that says something else happened.
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

        // WHICH CHECKOUT owns this file? Git's answer, via the resolver the bash half already uses —
        // never a path-containment test, which is exactly what answered "primary" for a worktree
        // checked out INSIDE the repo (issue #851, and this class's header).
        const target = new TargetTreeResolver().resolve(ctx.filePath, ctx.workspaceRoot);
        // A NESTED CLONE under `repositories/**` is somebody else's repo. The bash path calls this
        // ALLOW_EXEMPT; here it is an abstention, because the state was not established, not waived.
        if (target.kind === 'foreign') return this.failOpen(ctx, null, 'target-tree-foreign');

        const judgedRoot = target.root;
        const branch = this.currentBranch(judgedRoot);
        // Can't determine branch (e.g. not a git repo) → don't block. Fail-open.
        if (branch === null) return this.failOpen(ctx, branch, 'branch-undeterminable', this.treeSummary(judgedRoot));
        // Mid-rebase / mid-bisect: `--abbrev-ref HEAD` prints the literal `HEAD`, there is no branch
        // name, and therefore no key into the branch-keyed cache. Matrix row 14 — abstain, out loud.
        if (branch === 'HEAD') return this.failOpen(ctx, branch, 'detached-head', this.treeSummary(judgedRoot));

        const judged = new JudgedTree(target, branch, target.governedRoot);

        // State 1: on main — synchronous, no cache needed.
        if (branch === 'main') {
            return this.block(ctx, branch, 'on-main', this.onMainMessage(judged), this.treeSummary(judgedRoot));
        }

        // Keep the cache warm for the next call. Detached; never blocks this edit. Rooted at the JUDGED
        // tree, so the refresher recomputes the entry this guard is about to read rather than a sibling's.
        triggerMainSyncRefresh(judgedRoot, hangTimeoutOf(this.config));

        const status = readMainSyncStatus(judgedRoot, branch);
        // No cache yet (first edit of the session) → allow; the refresh we just spawned populates it
        // for the next call. Fail-open: never block on missing data.
        if (status === null) return this.failOpen(ctx, branch, 'no-sync-cache', 'cache=none');

        const cache = `${this.treeSummary(judgedRoot)} ${this.cacheSummary(status)}`;
        // BELT-AND-BRACES since the cache became branch-keyed: we looked this entry up BY `branch`, so
        // a mismatch now means the map's key and the entry's own `branch` field disagree — a shape bug,
        // not a normal state. Kept (rather than deleted) so such a bug degrades to an allow instead of
        // blocking on another branch's signals. Unreachable in normal operation.
        if (status.branch !== branch) return this.failOpen(ctx, branch, 'stale-cross-branch-cache', cache);

        // State 2: this feature branch was already merged into main.
        if (status.branchAlreadyMerged) {
            const pr = status.mergedPr !== '' ? status.mergedPr : '?';
            const merged = this.alreadyMergedMessage(judged, status.mergedPr);
            return this.block(ctx, branch, `already-merged PR#${pr}`, merged, cache);
        }
        // State 3: no fork point — main was merged into the branch.
        if (!status.hasForkPoint) {
            return this.block(ctx, branch, 'no-fork-point', this.noForkPointMessage(judged), cache);
        }
        // State 4: origin/main moved and touches files you changed.
        if (status.conflict) {
            return this.block(ctx, branch, 'main-moved-conflict', this.conflictMessage(judged, status.conflictFiles, status.openPr), cache);
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

    /**
     * WHICH TREE this decision was judged against, for the log.
     *
     * The trail already carried a `tree=` field, but it is stamped from the root the decision is LOGGED
     * to (the session's), so during issue #851 every misfired block recorded `tree=primary` for a path
     * under `.claude/worktrees/` and read as perfectly ordinary. This one is the root the verdict was
     * actually computed from, so the two disagreeing is the defect, visible in one grep.
     */
    private treeSummary(judgedRoot: string): string {
        return `judged=${judgedRoot}`;
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

    /**
     * The Write/Edit half of row 5. Same three points as stale-main-bash-guard's deny, told for THIS
     * surface: reading main while you plan is legitimate and is not what got blocked; the feature
     * branch is the unit of work; and a `main` that is behind makes the reads wrong too, so getting
     * current is not an extra step, it is what makes the plan you are about to write against correct.
     *
     * Per-surface, deliberately: this guard sees only Write/Edit, so it says the WRITE was blocked.
     * (read-stale-guard is the one that can close Read, and only once `main` falls behind.)
     *
     * ONE CURE, and it is the dirty-safe one. This half used to print `git pull origin main` and then
     * "create a feature branch" — but this guard fires on a WRITE, so uncommitted work is the LIKELY
     * state, and a pull is exactly the form that is not a clean fast-forward there. Its two siblings
     * (stale-main-bash-guard's rows-6/7 deny, StaleMainMessage.forReads) both prescribe
     * `git fetch origin main && git checkout -b <new> origin/main`, which fetches AND carries the
     * uncommitted work onto the new branch. Three halves of one row printing one cure is the point:
     * a fragile cure is a defect here even when it often happens to work.
     */
    private onMainMessage(judged: JudgedTree): string {
        const convention = this.config.branchNamingConvention ?? '{whoami}/{featurename}';
        return [
            judged.header(),
            'Blocked: this is a WRITE on main. Reading main to PLAN is fine — writing here is not, because the feature branch is the unit of work: reviewable, revertable, and not one `git checkout` from being lost.',
            'And if local main is BEHIND origin/main, what you read here was out of date too — so the fetch below is not an extra step, it is what makes your reads true.',
            'Branch off origin/main (it fetches first, and uncommitted work comes with you):',
            '  git fetch origin main && git checkout -b <new-branch> origin/main',
            `Name <new-branch> by the convention (from webpieces.config.json): ${convention}`,
            'Example: git fetch origin main && git checkout -b ' + convention.replace(/<[^>]+>/g, 'value') + ' origin/main',
            judged.redirectNote([judged.cdCure('git fetch origin main && git checkout -b <new-branch> origin/main')]),
        ].join('\n');
    }

    // Shared with read-stale-guard, which blocks READS in this same state — see MergedBranchMessage.
    // The tree kind picks the flavour of the cure: a dead LINKED WORKTREE is told to open a new
    // worktree off origin/main and reap this one; the primary clone is told to branch off origin/main.
    // Every one of those questions is asked of the JUDGED tree, not the session's: the branch that is
    // merged, the checkout to recover, and the directory the cure has to run in are all properties of
    // the tree that owns the file (issue #851).
    private alreadyMergedMessage(judged: JudgedTree, mergedPr: string): string {
        const body = new MergedBranchMessage(judged.root).forEdits(
            judged.branch, mergedPr, new TreeRecovery().kindOf(judged.root), judged.root,
        );
        // NO redirect note here, deliberately. MergedBranchMessage was built with the JUDGED root and
        // already aims every command it prints through `atRoot` — and it picks the WORKTREE flavour of
        // the cure (open a NEW worktree off origin/main and reap this dead one) when that is what the
        // tree is. Appending a generic `checkout -b` would contradict the paragraph directly above it,
        // in exactly the redirected-and-a-worktree case where the worktree flavour is the right advice.
        return [judged.header(), body].join('\n');
    }

    private conflictMessage(judged: JudgedTree, conflictFiles: readonly string[], openPr: string): string {
        const files = conflictFiles.length > 0
            ? conflictFiles.map((f: string): string => `  - ${f}`).join('\n')
            : '  (see git diff)';
        // NAME THE BRANCH AND THE TREE. Without them this read "files you also changed", listing files
        // the edit had never touched on a branch it was not on, and there was nothing in the text to
        // contradict — see JudgedTree.
        const header = [
            judged.header(),
            `origin/main moved and touched files that \`${judged.branch}\` also changed since its fork point:`,
            files,
            '',
        ];
        const redirect = judged.redirectNote([
            judged.pnpmCure('wp-start-update'),
            `${judged.pnpmCure('wp-start-upsert-pr')}   (instead, when a PR is open)`,
        ]);
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
                .concat([redirect])
                .join('\n');
        }
        return header
            .concat([
                'You must merge main in before editing further. No PR is open for this branch, so flow A',
                'below is the one to use — but use flow B the moment a PR exists:',
                '',
            ])
            .concat(guidance.flows())
            .concat([redirect])
            .join('\n');
    }

    private noForkPointMessage(judged: JudgedTree): string {
        return [
            judged.header(),
            'No fork point with origin/main — main appears to have been merged into this branch,',
            'so a clean squash-merge is impossible. A human must redo the work on a fresh branch:',
            '',
            ...squashRecoverySteps(judged.branch),
            judged.redirectNote([judged.pnpmCure('wp-start-update')]),
        ].join('\n');
    }
}
