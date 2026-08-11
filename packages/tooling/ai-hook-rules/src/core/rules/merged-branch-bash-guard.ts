import { execSync } from 'child_process';

import {
    BranchStateGuardConfig,
    BRANCH_STATE_GUARD_KEY,
    DEFAULT_HANG_TIMEOUT_MINUTES,
    readMainSyncStatus,
    MainSyncStatus,
} from '@webpieces/rules-config';

import type { BashContext, Violation } from '../types';
import { Violation as V } from '../types';
import { BashRuleBase } from '../rule-base';
import { FixHint, Option } from '../fix-hint';
import { toError } from '../to-error';
import { triggerMainSyncRefresh } from '../main-sync-refresh';
import { logGuardDecision, GuardDecision, Verdict, matrixL2Row } from '../decision-log';
import { L0_FAULT_NONE } from '../l0-fault-codes';
import { CommandScanner, CommandSegment } from '../command-scan';
import { MergedBranchMessage } from './merged-branch-message';
import { TreeRecovery } from './tree-recovery';
import { ShellSegmentScan, SegmentVerdict } from './shell-segment-scan';
import { ContentReadScan } from './content-read-scan';

/**
 * The BASH half of the merged-branch protection — the gap that let a whole session run on an
 * already-merged branch.
 *
 * feature-branch-guard blocks Write/Edit and read-stale-guard blocks the Read tool when the
 * checked-out branch's PR is already merged into main, but BOTH are file-scoped: a `runBash()` command
 * never reaches either. So an agent that only ran shell — `scripts/local.sh start lang` (boots
 * servers), `cat`/`ls` of repo files, git — sailed through, even though the very same
 * `branchAlreadyMerged` flag was loaded and logged on the Bash path (the `calls/` stream →
 * `merged=PR#…`). It was computed and thrown away; nothing consulted it for a block.
 *
 * Those two file guards intentionally leave Bash alone ("every cure is a Bash command, so Bash is the
 * escape hatch — never wedge it"). This guard therefore DEFAULT-DENIES Bash on a merged branch but
 * allowlists exactly the commands that get you OFF the branch (the fresh-start / cleanup git commands,
 * switching away, read-only orientation, wp-* cleanup, installs). The redirect it returns names those
 * same commands, so following it can never re-trip the guard — the agent is redirected, not wedged.
 *
 * FAIL-OPEN like its siblings: branch undeterminable, no cache yet, or a cache for a DIFFERENT branch
 * → allow. The cache is per-branch (`status.branch` is the branch it was computed FOR), so acting on
 * another branch's snapshot is never allowed.
 *
 * On the DELIBERATELY-UNFIXED staleness window: the cache is only as fresh as the last detached
 * refresh, so for a few seconds after a merge lands mid-session it can still read `merged=NO` and this
 * guard fails open. That window is tiny and self-closing — agents burst tool calls every few seconds
 * and every Bash call re-triggers the refresh, so `branchAlreadyMerged` flips within 1–3 calls and the
 * next command is caught. Closing it synchronously would require the slow `gh pr list` on the blocking
 * path (the thing the whole cache design avoids) and would mean blocking on stale/uncertain data,
 * which violates the fail-open principle every one of these guards is built on. Not worth it.
 */
export class MergedBranchBashGuardRule extends BashRuleBase<BranchStateGuardConfig> {
    constructor(config: BranchStateGuardConfig) { super(config, 'merged-branch-bash-guard', BRANCH_STATE_GUARD_KEY); }

    private readonly scanner = new CommandScanner();
    private readonly shell = new ShellSegmentScan(this.scanner);

    readonly description =
        'Block ordinary Bash on an already-merged branch (allowlisting only recovery/cleanup and ' +
        'read-only inspection commands), so a session cannot proceed on a stale post-merge branch.';
    override readonly defaultOptions = {
        hangTimeoutMinutes: DEFAULT_HANG_TIMEOUT_MINUTES,
    };
    readonly fixHint = new FixHint(
        'This branch is already merged into main — do not keep working here.',
        'Get onto a fresh branch off origin/main, then retry:',
        [
            new Option('git fetch origin main && git checkout -b <new-branch> origin/main (in a worktree: git worktree add ../<dir> -b <new> origin/main). Then re-run your command.', true),
            new Option('Still allowed here: recovery/cleanup git, read-only git status|log|diff|show|branch and gh pr list|view, switching branches/worktrees, pnpm wp-cleanup, and installs/upgrades.'),
            new Option('Disable in webpieces.config.json under hookGuards → branch-state-guard (mode OFF) if intentional — that one key governs the Write, Read and Bash halves of this policy together.'),
        ],
    );

    check(ctx: BashContext): readonly Violation[] {
        const branch = this.currentBranch(ctx.workspaceRoot);
        // Can't determine the branch (not a git repo, git unavailable) → never block. Fail-open.
        if (branch === null) return this.failOpen(ctx, branch, 'branch-undeterminable');

        // Keep the shared cache warm for the next call. Detached; never blocks this command. (The
        // runner also warms it, but only when feature-branch-guard is loaded — do it here too so this
        // guard is self-sufficient when that one is off.)
        triggerMainSyncRefresh(ctx.workspaceRoot, this.config.hangTimeoutMinutes ?? DEFAULT_HANG_TIMEOUT_MINUTES);

        const status = readMainSyncStatus(ctx.workspaceRoot, branch);
        // No cache yet (first command of the session), or a branch this refresh has not seen → allow;
        // the refresh we just spawned populates it.
        if (status === null) return this.failOpen(ctx, branch, 'no-sync-cache', 'cache=none');

        const cache = this.cacheSummary(status);
        // BELT-AND-BRACES since the cache became branch-keyed: the entry was looked up BY `branch`, so
        // a mismatch is a shape bug rather than the old "cache is for another branch" state. Kept so
        // such a bug degrades to an allow. Unreachable in normal operation.
        if (status.branch !== branch) return this.failOpen(ctx, branch, 'stale-cross-branch-cache', cache);

        // NOT-MERGED, or NOT-ASKED? `branchAlreadyMerged: false` is produced both by "this branch has
        // no merged PR" and by "the forge could not be reached" (`gh` missing, unauthenticated,
        // rate-limited, offline). Same allow either way — never block on data you could not establish
        // — but the LOG must not call the second one an approval, or the trail cannot tell a policy
        // that is protecting something from one that is quietly standing down.
        // For THIS guard the merged flag is the ONLY block condition, so an unreachable forge means
        // it is fully abstaining — the state it exists to catch cannot be observed at all.
        if (!status.branchAlreadyMerged) {
            return status.forgeReachable
                ? this.allow(ctx, branch, 'clean-feature-branch', cache)
                : this.failOpen(ctx, branch, 'no-forge', cache);
        }

        // Merged. Allow ONLY when every segment of the command is a recovery / cleanup / read-only
        // inspection command — anything else (servers, builds, tests, cat/ls of repo files, git writes)
        // is denied with the redirect.
        if (this.isFullyRecovery(ctx)) {
            return this.allow(ctx, branch, 'merged-branch recovery/inspection (allowlisted)', cache);
        }

        const pr = status.mergedPr !== '' ? status.mergedPr : '?';
        return this.block(ctx, branch, `already-merged PR#${pr}`, this.mergedMessage(ctx.workspaceRoot, branch, status.mergedPr), cache);
    }

    /**
     * A command is a recovery command only when EVERY one of its segments is — a single
     * `… && scripts/local.sh start` in the chain is enough to deny the whole thing.
     *
     * Segments are judged by ROLE first (see ShellSegmentScan). Shell STRUCTURE (`for … in`, `do`,
     * `done`) invokes nothing, and output SHAPING (`| tail -40`, `; echo done`) cannot touch the repo
     * — so neither may veto a chain. Judging the raw string instead is what made the guard reject
     * `git fetch origin main 2>&1 | tail -5`, a command its own redirect had just told the agent to run.
     */
    private isFullyRecovery(ctx: BashContext): boolean {
        const segments = this.scanner.segmentsWithPipes(ctx.command);
        if (segments.length === 0) return false;
        const content = new ContentReadScan(this.scanner, ctx.workspaceRoot, ctx.effectiveCwd);
        return segments.every((segment: CommandSegment): boolean => this.isRecoverySegment(segment, content));
    }

    private isRecoverySegment(segment: CommandSegment, content: ContentReadScan): boolean {
        const verdict = this.shell.classify(segment);
        if (verdict.role === 'structure') return true;
        // Inert / piped-into filters are fine EXCEPT when they name a workspace path: `git status |
        // cat src/foo.ts` still hands the agent pre-merge file content, which is the thing this guard
        // is protecting against. ContentReadScan already draws exactly that line.
        if (verdict.role === 'shaping') return content.readsStaleContent(segment) === null;

        // A read that names NOTHING in this tree cannot be affected by which branch this tree is on.
        // `ls -la ~/.claude/projects/ | grep -i foo` was blocked as "this branch is merged" — the
        // command touches no repo at all. Only CONTENT READERS qualify, so a build, a server or a git
        // write never slips through on the strength of its paths.
        if (content.readsOnlyOutsideContent(segment)) return true;

        const gitSub = this.scanner.gitSubcommandOf(verdict.words);
        if (gitSub !== null) return ALLOWED_GIT_SUBCOMMANDS.has(gitSub);
        if (this.isGhInspection(verdict)) return true;
        if (this.isPackageRecovery(verdict)) return true;
        return false;
    }

    // Read-only / status `gh` invocations used for orientation, INCLUDING `gh run view|list|watch` —
    // watching CI is precisely what you do while parked on a just-merged branch. gh writes (pr
    // create/merge, run cancel/rerun, api POSTs) are governed by pr-creation-or-push-guard /
    // pr-merge-guard and are NOT allowlisted here.
    private isGhInspection(verdict: SegmentVerdict): boolean {
        const words = verdict.words;
        if (words.length === 0 || words[0] !== 'gh') return false;
        const top = words[1];
        if (top === undefined) return false;
        const action = words[2];
        const readActions = GH_READ_ACTIONS.get(top);
        if (readActions !== undefined) return action !== undefined && readActions.has(action);
        return GH_READ_TOPLEVEL.has(top);
    }

    // pnpm/npm/yarn recovery bins: the `wp-*` cleanup/gated commands and package installs (a chained
    // install that isInstallerCommand — the pure-install bypass — did not catch reaches here).
    private isPackageRecovery(verdict: SegmentVerdict): boolean {
        const words = verdict.words;
        if (words.length === 0 || !PACKAGE_MANAGERS.has(words[0])) return false;
        return words.slice(1).some((word: string): boolean =>
            /^wp-[a-z-]+$/.test(word) || PACKAGE_INSTALL_VERBS.has(word));
    }

    private mergedMessage(workspaceRoot: string, branch: string, mergedPr: string): string {
        return new MergedBranchMessage(workspaceRoot).forBash(
            branch, mergedPr, new TreeRecovery().kindOf(workspaceRoot), workspaceRoot,
        );
    }

    // One-line summary of the async-written cache that drove this decision (mirrors the file guards),
    // so a wrong allow/block is traceable to the exact main-sync-status.json read.
    private cacheSummary(status: MainSyncStatus): string {
        const merged = status.branchAlreadyMerged ? `PR#${status.mergedPr !== '' ? status.mergedPr : '?'}` : 'no';
        return `cache=${status.branch} merged=${merged} conflict=${String(status.conflict)} ts=${status.timestamp}`;
    }

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
    private failOpen(ctx: BashContext, branch: string | null, reason: string, cache: string = '-'): readonly Violation[] {
        this.logDecision(ctx, branch, 'ALLOW_FAIL_OPEN', reason, cache);
        return [];
    }

    private allow(ctx: BashContext, branch: string | null, reason: string, cache: string = '-'): readonly Violation[] {
        this.logDecision(ctx, branch, 'ALLOW', reason, cache);
        return [];
    }

    private block(ctx: BashContext, branch: string, reason: string, message: string, cache: string = '-'): readonly Violation[] {
        this.logDecision(ctx, branch, 'BLOCK_AI_CURE', reason, cache);
        return [new V(1, this.truncate(ctx.command), message)];
    }

    private truncate(s: string): string {
        const MAX = 120;
        return s.length <= MAX ? s : s.slice(0, MAX) + '…';
    }

    private logDecision(ctx: BashContext, branch: string | null, verdict: Verdict, reason: string, cache: string): void {
        logGuardDecision(
            ctx.workspaceRoot,
            new GuardDecision('merged-branch-bash-guard', 'Bash', ctx.command, branch ?? 'unknown', verdict, reason, cache, L0_FAULT_NONE, matrixL2Row(reason)),
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
}

// git subcommands that are recovery/cleanup OR read-only orientation, and so stay allowed on a merged
// branch. Everything NOT here (commit, merge, rebase, push, reset, add, restore, clean, cherry-pick,
// …) is a "keep working" operation and is denied with the redirect. `worktree` covers add/remove/prune
// (branch-creation-guard governs which worktree adds are legal); `branch` covers listing and `-D`
// cleanup (branch-creation-guard governs creation); `pull` is the on-main update, itself gated by
// redirect-how-to-merge-main. Reading git METADATA (log/diff/show) is fine — it is not the stale FILE
// CONTENT that `cat` would surface, which is exactly why `git grep` (reads tracked content) is absent.
const ALLOWED_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set([
    'status', 'log', 'diff', 'show', 'branch', 'checkout', 'switch', 'worktree', 'fetch', 'pull',
    'rev-parse', 'rev-list', 'merge-base', 'ls-files', 'ls-tree', 'cat-file', 'for-each-ref',
    'symbolic-ref', 'describe', 'name-rev', 'reflog', 'shortlog', 'remote', 'config', 'stash', 'tag',
    'blame', 'whatchanged', 'cherry',
]);

// Read-only actions per `gh` topic. `run` is here because `gh run view <id>` was blocked outright in
// the field while `gh pr view` beside it succeeded — both are read-only, and CI watching is the normal
// thing to do while parked. The WRITE actions of the same topics (pr create/merge/close, run
// cancel/rerun/delete) are simply absent, so they still fall through to the block.
const GH_READ_ACTIONS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
    ['pr', new Set(['list', 'view', 'status', 'checks', 'diff'])],
    ['run', new Set(['list', 'view', 'watch'])],
    ['issue', new Set(['list', 'view', 'status'])],
]);
// Read-only top-level `gh` commands.
const GH_READ_TOPLEVEL: ReadonlySet<string> = new Set(['status', 'auth', 'browse', 'repo', 'search']);

const PACKAGE_MANAGERS: ReadonlySet<string> = new Set(['pnpm', 'npm', 'npx', 'pnpx', 'yarn']);
const PACKAGE_INSTALL_VERBS: ReadonlySet<string> = new Set(['install', 'ci', 'add', 'i']);
