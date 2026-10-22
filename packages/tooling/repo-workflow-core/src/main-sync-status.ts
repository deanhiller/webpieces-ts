import { injectable, bindingScopeValues } from 'inversify';

import { AtomicFile } from '@webpieces/tooling-common';
import {
    MAIN_SYNC_STATUS_VERSION,
    MainSyncFileStore,
    MainSyncStatus,
    MainSyncStatusFile,
    PullRequestIndex,
    RefreshOutcome,
} from './main-sync-file';
import { DotWebpieces, dotWebpieces, gitCheckout } from '@webpieces/tooling-common';
import { toError } from '@webpieces/tooling-common/to-error';
import { WorktreeService } from './worktrees';
import { CommandTimeouts } from './command-timeouts';

// The on-disk shape lives in main-sync-file.ts; re-exported so every existing importer of
// `MainSyncStatus` from this module keeps working.
export { MainSyncStatus, MainSyncStatusFile, PullRequestIndex, MAIN_SYNC_STATUS_VERSION, RefreshOutcome };

// Shared "is my feature branch healthy relative to origin/main?" state. The SLOW signals (git fetch +
// merge-base + same-file-overlap + a merged-PR lookup) are computed by the ai-hook-rules refresher in a
// DETACHED background process; the feature-branch-guard only READS this cached file. pr-gate's merge
// flow also writes it synchronously after a merge. Lives here (the shared dep of both).

// How long a refresher may hold main-sync.lock.json before the next spawner assumes it hung, kills it
// and reclaims the lock (see MainSyncLockService).
export const DEFAULT_HANG_TIMEOUT_MINUTES = 5;

const MAIN_SYNC_STATUS_FILE = 'main-sync-status.json';

// Internal: one bounded command's verdict and trimmed stdout. Data only.
class CapturedOutput {
    constructor(readonly ok: boolean, readonly out: string) {}
}

/**
 * Reads/writes the main-sync cache and computes the slow "is my branch healthy vs origin/main?"
 * status. `@injectable(bindingScopeValues.Singleton)` so it's injectable and drawn in consumers’ DI designs.
 */
@injectable(bindingScopeValues.Singleton)
export class MainSyncStatusService {
    constructor(
        private readonly dotDir: DotWebpieces = dotWebpieces,
        private readonly atomicFile: AtomicFile = new AtomicFile(),
        private readonly store: MainSyncFileStore = new MainSyncFileStore(atomicFile),
        private readonly worktrees: WorktreeService = new WorktreeService(),
        private readonly commands: CommandTimeouts = new CommandTimeouts(),
    ) {}

    /**
     * SHARED scope: `<primary>/.webpieces/main-sync-status.json`, one per repo.
     *
     * It is the OUTPUT of the single-flight refresher below, so it has to live where the lock lives —
     * one `.git`, one `origin/main`, one fetch, one answer. A per-worktree copy under single-flight
     * would only ever be written for whichever worktree won the lock anyway.
     *
     * FORMERLY a known defect, now fixed: the file's CONTENT used to be keyed to ONE branch, and every
     * reader fails OPEN when the cached branch is not the branch being judged (`stale-cross-branch-cache
     * (fail-open)`). With several worktrees on several branches, only the winner of the lock was ever
     * described, so every other worktree's guards abstained — and which one was armed thrashed as the
     * lock changed hands. The file is now a MAP of branch -> status (see MainSyncStatusFile): the single
     * winning refresher enumerates every worktree and records all of their branches in one atomic write,
     * so one fetch arms everyone. Single-flight is unchanged; only what the winner writes changed.
     */
    mainSyncStatusPath(repoRoot: string): string {
        return this.dotDir.sharedFile(repoRoot, MAIN_SYNC_STATUS_FILE);
    }

    /**
     * The cached status FOR ONE BRANCH — the only read the four main-sync guards perform.
     *
     * `branch` is mandatory and is the branch being judged. A branch the last refresh never saw
     * returns null, which every guard already treats as `no-sync-cache (fail-open)`, so an unknown
     * branch degrades exactly as a missing file did. Any error (missing, truncated, malformed JSON)
     * also returns null — this must never throw on the blocking path.
     */
    readMainSyncStatus(repoRoot: string, branch: string): MainSyncStatus | null {
        return this.store.branchStatus(this.readMainSyncStatusFile(repoRoot), branch);
    }

    // The whole branch-keyed document, or null. Callers that need more than one branch use this.
    readMainSyncStatusFile(repoRoot: string): MainSyncStatusFile | null {
        return this.store.readFile(this.mainSyncStatusPath(repoRoot));
    }

    /**
     * Merge ONE branch's entry into the existing map, atomically, leaving siblings untouched.
     *
     * Read-modify-write rather than replace: this is the writer used by everyone who is NOT the
     * single-flight refresher (notably pr-gate's post-merge stamp, which holds no lock and knows about
     * exactly one branch). Replacing the document from there would erase every other worktree's entry
     * and silently disarm their guards until the next refresh.
     */
    writeMainSyncStatus(repoRoot: string, status: MainSyncStatus): void {
        this.store.mergeBranch(this.mainSyncStatusPath(repoRoot), status);
    }

    /**
     * Replace the WHOLE document — only the winning refresher may do this.
     *
     * ATOMIC (temp file + `rename()` in the same directory). The refresher writes this file while
     * guards on the blocking path read it, possibly from another worktree; a plain `writeFileSync`
     * truncates first, so a reader landing in that window gets a torn document. See AtomicFile.
     */
    writeMainSyncStatusFile(repoRoot: string, file: MainSyncStatusFile): void {
        this.store.writeFile(this.mainSyncStatusPath(repoRoot), file);
    }

    /**
     * Record that a refresh STARTED at `startedMs` and ended with `outcome`, keeping every branch entry
     * already on disk. The refresher's failure path: a run that produced no new branch data still
     * counts as a run, so the throttle retries it after MIN_REFRESH_INTERVAL_MINUTES rather than on
     * every tool call. A successful run stamps the whole document instead (writeMainSyncStatusFile).
     */
    recordRefreshOutcome(repoRoot: string, startedMs: number, outcome: RefreshOutcome): void {
        this.store.recordRefresh(this.mainSyncStatusPath(repoRoot), startedMs, outcome);
    }

    /**
     * The SLOW path for ONE branch: the branch checked out in `repoRoot`. Runs its own fetch and its
     * own `gh` query, so it is the right entry point for a single-worktree caller and for tests.
     * The refresher uses computeAllMainSyncStatuses instead — see there for why.
     */
    async computeMainSyncStatus(repoRoot: string): Promise<MainSyncStatus> {
        // Best-effort network refresh; offline just means we evaluate against the last-fetched ref.
        await this.fetchOriginMain(repoRoot);
        return this.computeBranchStatus(repoRoot, this.gitBranch(repoRoot), await this.loadPullRequestIndex(repoRoot));
    }

    /**
     * The SLOW path for EVERY branch this repo has checked out — what the detached refresher runs.
     *
     * The cache is shared by all worktrees but was written for one branch, so only one worktree's
     * guards were ever armed. Enumerating the worktrees here and writing all of their branches in one
     * atomic map arms every worktree off a single refresh.
     *
     * NETWORK COST DOES NOT SCALE WITH BRANCH COUNT, which is the whole reason this is a separate
     * method: ONE `git fetch` and ONE repo-wide `gh pr list` for all N branches (the old code asked
     * `gh` twice per branch, so looping it would have cost 2N round trips). Everything after that is
     * local git in each worktree — merge-base, rev-parse, diff, ls-files.
     *
     * The map is rebuilt from the LIVE worktree set every refresh, so a deleted branch or removed
     * worktree simply stops appearing. No pruning pass, no unbounded growth.
     */
    async computeAllMainSyncStatuses(repoRoot: string): Promise<MainSyncStatusFile> {
        await this.fetchOriginMain(repoRoot);
        const index = await this.loadPullRequestIndex(repoRoot);
        const branches: Record<string, MainSyncStatus> = {};
        for (const tree of this.worktrees.listWorktrees(repoRoot)) {
            // Detached HEAD (and a bare worktree) has no branch to key an entry on. Skipping it must
            // not stop the others being recorded, which is why this is a `continue`, not a bail-out.
            if (tree.branch === '' || this.hasBranch(branches, tree.branch)) continue;
            branches[tree.branch] = await this.computeBranchStatus(tree.path, tree.branch, index);
        }
        // `main` always present, even with no worktree on it: read-stale-guard's state A looks itself
        // up under 'main', and an absent entry there would silently disarm the stale-main block.
        if (!this.hasBranch(branches, 'main')) branches['main'] = await this.mainOnlyStatus(repoRoot);
        return new MainSyncStatusFile(MAIN_SYNC_STATUS_VERSION, new Date().toISOString(), branches);
    }

    private hasBranch(branches: Record<string, MainSyncStatus>, branch: string): boolean {
        return Object.prototype.hasOwnProperty.call(branches, branch);
    }

    /**
     * One branch's status, computed in `worktreePath` (the tree that has it checked out — the
     * working-tree overlap signals are only correct from there). Does NOT fetch and does NOT call
     * `gh`: both are done once per refresh by the caller.
     */
    // webpieces-disable max-lines-new-methods -- one cohesive slow-path computation
    private async computeBranchStatus(repoRoot: string, branch: string, index: PullRequestIndex): Promise<MainSyncStatus> {
        return this.stampForge(await this.computeBranchStatusInner(repoRoot, branch, index), index);
    }

    // Every return path of the computation below has to carry the forge flag, and threading it through
    // four constructions is how one of them would end up missing it. One wrapper, one assignment.
    private stampForge(status: MainSyncStatus, index: PullRequestIndex): MainSyncStatus {
        status.forgeReachable = index.forgeReachable;
        return status;
    }

    // webpieces-disable max-lines-new-methods -- one cohesive slow-path computation
    private async computeBranchStatusInner(repoRoot: string, branch: string, index: PullRequestIndex): Promise<MainSyncStatus> {
        const mergedPr = index.mergedFor(branch);
        const openPr = index.openFor(branch);

        const head = await this.git(repoRoot, ['rev-parse', 'HEAD']);
        const originMain = await this.git(repoRoot, ['rev-parse', 'origin/main']);
        const localMain = await this.localMainHash(repoRoot);
        const featureHead = head.ok ? head.out : '';
        if (!head.ok || !originMain.ok) {
            const status = this.benignStatus(branch, featureHead);
            status.branchAlreadyMerged = mergedPr !== '';
            status.mergedPr = mergedPr;
            status.openPr = openPr;
            status.localMain = localMain;
            status.commitsBehind = await this.commitDistance(repoRoot, localMain, originMain.ok ? originMain.out : '');
            return status;
        }

        const forkPoint = await this.git(repoRoot, ['merge-base', 'origin/main', 'HEAD']);
        if (!forkPoint.ok || forkPoint.out === '') {
            const noFork = new MainSyncStatus(branch, mergedPr !== '', mergedPr, false, null, originMain.out, featureHead, false, [], new Date().toISOString());
            noFork.openPr = openPr;
            noFork.localMain = localMain;
            noFork.commitsBehind = await this.commitDistance(repoRoot, localMain, originMain.out);
            return noFork;
        }

        const featureFiles = new Set(await this.featureChangedFiles(repoRoot, forkPoint.out));
        const mainFiles = await this.changedFiles(repoRoot, forkPoint.out, 'origin/main');
        const conflictFiles = mainFiles.filter((file: string): boolean => featureFiles.has(file));

        const status = new MainSyncStatus(
            branch,
            mergedPr !== '',
            mergedPr,
            true,
            forkPoint.out,
            originMain.out,
            featureHead,
            conflictFiles.length > 0,
            conflictFiles,
            new Date().toISOString(),
        );
        status.openPr = openPr;
        status.localMain = localMain;
        status.commitsBehind = await this.commitDistance(repoRoot, localMain, originMain.out);
        return status;
    }

    // The recovery steps when there is no fork point with origin/main (a bad merge of main into branch).
    squashRecoverySteps(currentBranch: string): string[] {
        return [
            '1. Fetch latest main:            git fetch origin main',
            `2. New branch off origin/main:   git checkout -b ${currentBranch}-v2 origin/main`,
            `3. Squash-merge old branch:      git merge --squash ${currentBranch}`,
            '   ^^ HUMAN-ONLY. `git merge` is blocked for AI (redirect-how-to-merge-main). AI: ask the',
            '   human to run step 3, and warn them it is a raw merge — only correct here because the',
            '   branch is already broken. For a normal update from main they should push back and',
            '   tell you to use the gated 3-point merge instead: `pnpm wp-start-update` (paired with',
            '   `pnpm wp-finish-update`) when no PR is open, or `pnpm wp-start-upsert-pr` (paired with',
            '   `pnpm wp-finish-upsert-pr`) when a PR IS open — a PR MUST use the upsert-pr pair.',
            `4. Commit the squash:            git add -A && git commit -m "Squashed from ${currentBranch}"`,
            '5. If a PR exists:               open a NEW PR for the -v2 branch and close the old one.',
        ];
    }

    /**
     * Synchronously stamp a clean "up to date with main" status — call right after a successful merge.
     *
     * This is the one writer that takes NO lock, and it knows about exactly one branch. It therefore
     * goes through writeMainSyncStatus, which MERGES its entry into the existing map; writing a whole
     * document from here would wipe every other worktree's entry.
     */
    async stampCleanMainSyncStatus(repoRoot: string): Promise<void> {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            const branch = this.gitBranch(repoRoot);
            const originMain = await this.git(repoRoot, ['rev-parse', 'origin/main']);
            const featureHead = await this.git(repoRoot, ['rev-parse', 'HEAD']);
            if (!originMain.ok || !featureHead.ok) return;
            const status = new MainSyncStatus(
                branch, false, '', true, originMain.out, originMain.out, featureHead.out, false, [], new Date().toISOString(),
            );
            status.localMain = await this.localMainHash(repoRoot);
            status.commitsBehind = 0;
            this.writeMainSyncStatus(repoRoot, status);
        } catch (err: unknown) {
            const error = toError(err);
            void error;
        }
    }

    /**
     * Refresh `origin/main` WITHOUT writing `.git/FETCH_HEAD`.
     *
     * WHY the flag is not optional: this runs in a DETACHED background process while the agent is
     * running its own foreground `git fetch` / `git pull` in the very same repo. `.git/FETCH_HEAD` is
     * a single file that git takes no lock on, so two overlapping fetches interleave their writes and
     * can leave the SAME `for-merge` line twice. `git pull` then reads two for-merge entries and dies
     * with `fatal: Cannot fast-forward to multiple branches` — wedging the exact command the
     * read-stale-guard tells the agent to run. `--no-write-fetch-head` (git >= 2.29) still updates the
     * remote-tracking ref, which is all anything downstream reads (`origin/main`, merge-base), so
     * nothing here needs FETCH_HEAD written at all.
     *
     * Older git rejects the flag; only then do we retry the plain form, accepting the old behaviour
     * rather than losing the refresh entirely on a pre-2020 git.
     */
    private async fetchOriginMain(repoRoot: string): Promise<void> {
        const safe = await this.commands.networkGit(['fetch', '--no-write-fetch-head', 'origin', 'main'], repoRoot);
        if (safe.ok) return;
        if (!this.isUnknownGitOption(safe.stderr)) return;  // a real failure (offline, auth) — not our business
        await this.commands.networkGit(['fetch', 'origin', 'main'], repoRoot);
    }

    // Did git reject the flag itself (too old), as opposed to failing the network refresh?
    private isUnknownGitOption(stderr: string): boolean {
        const text = stderr.toLowerCase();
        return text.includes('unknown option') || text.includes('unknown switch') || text.includes('unrecognized option');
    }

    // Local git, bounded (CommandTimeouts), stdout trimmed; ok=false on a non-zero exit, a kill or a failed start.
    private async git(repoRoot: string, args: string[]): Promise<CapturedOutput> {
        const result = await this.commands.localGit(args, repoRoot);
        return new CapturedOutput(result.ok, result.ok ? result.stdout.trim() : '');
    }

    // The actual checked-out branch in repoRoot — cwd-correct so the cache's `branch` label matches.
    private gitBranch(repoRoot: string): string {
        return gitCheckout.branch(repoRoot) ?? '';
    }

    // The LOCAL main hash. `refs/heads/main` (not the bare name) so it can never resolve to a remote
    // ref or a tag. '' when main does not exist locally — which the guard treats as fail-open.
    private async localMainHash(repoRoot: string): Promise<string> {
        const result = await this.git(repoRoot, ['rev-parse', 'refs/heads/main']);
        return result.ok ? result.out : '';
    }

    // Slow-path only: the detached refresher calls this after fetching. Guards never count commits.
    private async commitDistance(repoRoot: string, localMain: string, originMain: string): Promise<number | null> {
        if (localMain === '' || originMain === '') return null;
        const result = await this.git(repoRoot, ['rev-list', '--count', `${localMain}..${originMain}`]);
        if (!result.ok || !/^\d+$/.test(result.out)) return null;
        return Number(result.out);
    }

    private async changedFiles(repoRoot: string, base: string, head: string): Promise<string[]> {
        const result = await this.git(repoRoot, ['diff', '--name-only', base, head]);
        if (!result.ok || result.out === '') return [];
        return result.out.split('\n').map((line: string): string => line.trim()).filter((line: string): boolean => line.length > 0);
    }

    // Every file this feature branch has touched since the fork point — committed AND still in the
    // working tree (staged / unstaged / untracked), so a conflict is visible WHILE editing.
    private async featureChangedFiles(repoRoot: string, forkPoint: string): Promise<string[]> {
        const out = new Set<string>();
        const add = async (args: string[]): Promise<void> => {
            const r = await this.git(repoRoot, args);
            if (!r.ok || r.out === '') return;
            for (const line of r.out.split('\n')) {
                const f = line.trim();
                if (f.length > 0) out.add(f);
            }
        };
        await add(['diff', '--name-only', forkPoint, 'HEAD']);      // committed since the fork point
        await add(['diff', '--name-only', 'HEAD']);                 // unstaged working-tree edits
        await add(['diff', '--name-only', '--cached', 'HEAD']);     // staged edits
        await add(['ls-files', '--others', '--exclude-standard']);  // untracked new files (respects .gitignore)
        return [...out];
    }

    /**
     * ONE repo-wide `gh pr list` giving every branch's merged/open PR — replaces the two per-branch
     * `--head <branch>` queries. `--limit 200` bounds it; a branch whose only PR is older than that
     * falls out of the index and reads as "no PR", which is the fail-OPEN direction (no merged PR =
     * no block), the same way a missing `gh` or an offline machine already degraded.
     */
    private async loadPullRequestIndex(repoRoot: string): Promise<PullRequestIndex> {
        const gh = await this.commands.gh([
            'pr', 'list', '--state', 'all', '--json', 'number,headRefName,state', '--limit', '200',
        ], repoRoot);
        const result = new CapturedOutput(gh.ok, gh.ok ? gh.stdout.trim() : '');
        // `gh` could not be run, or exited non-zero (missing, unauthenticated, rate-limited, offline).
        // An EMPTY index is the same fail-open answer as before — but it is now labelled UNREACHABLE, so
        // the guards can report an abstention rather than an approval. Empty STDOUT on a zero exit is a
        // real answer ("this repo has no PRs"), so only the failure path clears the flag.
        if (!result.ok) return new PullRequestIndex({}, {}, false);
        if (result.out === '') return new PullRequestIndex({}, {}, true);
        return this.store.indexPullRequests(result.out);
    }

    /**
     * A `main` entry synthesised WITHOUT a worktree standing on main. Carries only the two hashes
     * read-stale-guard / stale-main-bash-guard actually compare (originMain vs the live tree's
     * ancestry) — never merged, never conflicting, so it can only ever produce the stale-main verdict.
     */
    private async mainOnlyStatus(repoRoot: string): Promise<MainSyncStatus> {
        const originMain = await this.git(repoRoot, ['rev-parse', 'origin/main']);
        const localMain = await this.localMainHash(repoRoot);
        const status = new MainSyncStatus(
            'main', false, '', true, localMain === '' ? null : localMain,
            originMain.ok ? originMain.out : '', localMain, false, [], new Date().toISOString(),
        );
        status.localMain = localMain;
        status.commitsBehind = await this.commitDistance(repoRoot, localMain, originMain.ok ? originMain.out : '');
        return status;
    }

    // A benign status that never blocks — used when origin/main can't be resolved.
    private benignStatus(branch: string, featureHead: string): MainSyncStatus {
        return new MainSyncStatus(branch, false, '', true, null, '', featureHead, false, [], new Date().toISOString());
    }
}

// Temporary migration delegators to MainSyncStatusService — removed once consumers inject it.
const mainSyncSvc = new MainSyncStatusService();

// webpieces-disable no-function-outside-class -- temporary back-compat delegator to MainSyncStatusService; removed once consumers inject it
export function mainSyncStatusPath(repoRoot: string): string { return mainSyncSvc.mainSyncStatusPath(repoRoot); }
// webpieces-disable no-function-outside-class -- temporary back-compat delegator to MainSyncStatusService; removed once consumers inject it
export function readMainSyncStatus(repoRoot: string, branch: string): MainSyncStatus | null { return mainSyncSvc.readMainSyncStatus(repoRoot, branch); }
// webpieces-disable no-function-outside-class -- temporary back-compat delegator to MainSyncStatusService; removed once consumers inject it
export function readMainSyncStatusFile(repoRoot: string): MainSyncStatusFile | null { return mainSyncSvc.readMainSyncStatusFile(repoRoot); }
// webpieces-disable no-function-outside-class -- temporary back-compat delegator to MainSyncStatusService; removed once consumers inject it
export function writeMainSyncStatus(repoRoot: string, status: MainSyncStatus): void { mainSyncSvc.writeMainSyncStatus(repoRoot, status); }
// webpieces-disable no-function-outside-class -- temporary back-compat delegator to MainSyncStatusService; removed once consumers inject it
export function writeMainSyncStatusFile(repoRoot: string, file: MainSyncStatusFile): void { mainSyncSvc.writeMainSyncStatusFile(repoRoot, file); }
// webpieces-disable no-function-outside-class -- temporary back-compat delegator to MainSyncStatusService; removed once consumers inject it
export function squashRecoverySteps(currentBranch: string): string[] { return mainSyncSvc.squashRecoverySteps(currentBranch); }

