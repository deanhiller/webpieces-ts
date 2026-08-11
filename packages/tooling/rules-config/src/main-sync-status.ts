import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { injectable, bindingScopeValues } from 'inversify';

import { AtomicFile } from './atomic-file';
import {
    MAIN_SYNC_STATUS_VERSION,
    MainSyncFileStore,
    MainSyncStatus,
    MainSyncStatusFile,
    PullRequestIndex,
} from './main-sync-file';
import { DotWebpieces, dotWebpieces } from './state-dir';
import { toError } from './to-error';
import { WorktreeService } from './worktrees';

// The on-disk shape lives in main-sync-file.ts; re-exported so every existing importer of
// `MainSyncStatus` from this module keeps working.
export { MainSyncStatus, MainSyncStatusFile, PullRequestIndex, MAIN_SYNC_STATUS_VERSION };

// Shared "is my feature branch healthy relative to origin/main?" state. The SLOW signals (git fetch +
// merge-base + same-file-overlap + a merged-PR lookup) are computed by the ai-hook-rules refresher in a
// DETACHED background process; the feature-branch-guard only READS this cached file. pr-gate's merge
// flow also writes it synchronously after a merge. Lives here (the shared dep of both).

// How long an `inprocess` refresher lock may sit before a new refresher assumes the prior run hung.
export const DEFAULT_HANG_TIMEOUT_MINUTES = 5;

const MAIN_SYNC_STATUS_FILE = 'main-sync-status.json';
const MAIN_SYNC_LOCK_FILE = 'main-sync.lock.json';

const LOCK_STATE_INPROCESS = 'inprocess';
const LOCK_STATE_FINISHED = 'finished';

// Concurrency state machine for the detached refresher. `started` is epoch ms. `pid` is the refresher
// process's pid (0 = unknown) — used so a KILLED refresher doesn't wedge `inprocess` for the timeout.
export class MainSyncLock {
    state: string;
    started: number;
    pid: number;

    constructor(state: string, started: number, pid: number = 0) {
        this.state = state;
        this.started = started;
        this.pid = pid;
    }
}

// Raw JSON shape for the cast at the parse boundary.
interface RawLock {
    state?: string;
    started?: number;
    pid?: number;
}

// Result of a captured git/gh invocation: ok=false on spawn failure or non-zero exit.
interface CmdCapture {
    ok: boolean;
    out: string;
}

/**
 * Reads/writes the main-sync cache + lock and computes the slow "is my branch healthy vs origin/main?"
 * status. `@injectable(bindingScopeValues.Singleton)` so it's injectable and drawn in the rules-config DI design.
 */
@injectable(bindingScopeValues.Singleton)
export class MainSyncStatusService {
    constructor(
        private readonly dotDir: DotWebpieces = dotWebpieces,
        private readonly atomicFile: AtomicFile = new AtomicFile(),
        private readonly store: MainSyncFileStore = new MainSyncFileStore(atomicFile),
        private readonly worktrees: WorktreeService = new WorktreeService(),
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
     * SHARED scope — the single-flight lock for the whole repo.
     *
     * This is the fix for the filed bug "the detached main-sync refresher's `git fetch` races the
     * agent's foreground `git fetch`/`git pull` and corrupts `.git/FETCH_HEAD`". The lock was already
     * atomic (O_CREAT|O_EXCL) and already serialised refreshers against each other — but only WITHIN
     * one worktree, so N worktrees meant N locks and up to N concurrent `git fetch`es against the ONE
     * shared `.git`, which is exactly how a duplicate `for-merge` line lands in FETCH_HEAD. There is
     * one `.git`, so there is now one lock: at most one refresher in flight across all worktrees.
     *
     * Stale-lock handling is unchanged and still required (a lock nobody can clear is worse than the
     * race): the holder records pid + start epoch, and `tryAcquireMainSyncLock` reclaims it once
     * `isRefreshInProgress` proves the holder is finished, hung past hangTimeoutMinutes, or dead.
     */
    mainSyncLockPath(repoRoot: string): string {
        return this.dotDir.sharedFile(repoRoot, MAIN_SYNC_LOCK_FILE);
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

    readMainSyncLock(repoRoot: string): MainSyncLock | null {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            const lockPath = this.mainSyncLockPath(repoRoot);
            if (!fs.existsSync(lockPath)) return null;
            const raw = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as RawLock;
            return new MainSyncLock(raw.state ?? LOCK_STATE_FINISHED, raw.started ?? 0, raw.pid ?? 0);
        } catch (err: unknown) {
            const error = toError(err);
            void error;
            return null;
        }
    }

    writeMainSyncLock(repoRoot: string, lock: MainSyncLock): void {
        const lockPath = this.mainSyncLockPath(repoRoot);
        this.ensureDir(lockPath);
        fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');
    }

    // A lock is stale (prior refresher assumed hung) once `inprocess` longer than hangTimeoutMinutes.
    isLockStale(lock: MainSyncLock, hangTimeoutMinutes: number, now: number = Date.now()): boolean {
        return now - lock.started > hangTimeoutMinutes * 60 * 1000;
    }

    // True when another refresher is actively running and we should NOT start a second one.
    isRefreshInProgress(repoRoot: string, hangTimeoutMinutes: number, now: number = Date.now()): boolean {
        const lock = this.readMainSyncLock(repoRoot);
        if (!lock) return false;
        if (lock.state !== LOCK_STATE_INPROCESS) return false;
        if (this.isLockStale(lock, hangTimeoutMinutes, now)) return false;
        return this.isProcessAlive(lock.pid);
    }

    /**
     * ATOMICALLY take the refresher lock. Returns the held lock, or null when someone else holds it.
     *
     * Replaces the check-then-write pair (`isRefreshInProgress` then `writeMainSyncLock`), whose gap
     * let two detached refreshers both pass the check and then both run `git fetch` at once — the
     * concurrency this lock exists to prevent. The create uses the `wx` flag (O_CREAT|O_EXCL), so of
     * N racing refreshers exactly one creates the file.
     *
     * A lock file left behind by a FINISHED, hung, or killed refresher is reclaimed: we only unlink
     * and re-take it once `isRefreshInProgress` says the holder is provably not running, and we
     * re-read afterwards to confirm the entry we see is ours before claiming the lock.
     */
    tryAcquireMainSyncLock(
        repoRoot: string,
        hangTimeoutMinutes: number,
        now: number = Date.now(),
        pid: number = process.pid,
    ): MainSyncLock | null {
        const lockPath = this.mainSyncLockPath(repoRoot);
        this.ensureDir(lockPath);
        const lock = this.inProcessLock(now, pid);
        const payload = JSON.stringify(lock, null, 2) + '\n';

        if (this.createExclusive(lockPath, payload)) return lock;

        // The file already exists. Leave it alone while a live refresher owns it.
        if (this.isRefreshInProgress(repoRoot, hangTimeoutMinutes, now)) return null;

        // Reclaim it: remove the dead entry, then re-take it exclusively so only one reclaimer wins.
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            fs.unlinkSync(lockPath);
        } catch (err: unknown) {
            const error = toError(err);
            void error;  // someone else reclaimed it first — the exclusive create below decides
        }
        if (!this.createExclusive(lockPath, payload)) return null;

        // Confirm the lock on disk is OURS (a simultaneous reclaimer could have unlinked ours and
        // written its own between the two calls above).
        const held = this.readMainSyncLock(repoRoot);
        if (!held || held.pid !== pid || held.started !== lock.started) return null;
        return lock;
    }

    // O_CREAT|O_EXCL write: true when THIS call created the file, false when it already existed.
    private createExclusive(lockPath: string, payload: string): boolean {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            fs.writeFileSync(lockPath, payload, { flag: 'wx' });
            return true;
        } catch (err: unknown) {
            const error = toError(err);
            void error;
            return false;
        }
    }

    inProcessLock(now: number = Date.now(), pid: number = process.pid): MainSyncLock {
        return new MainSyncLock(LOCK_STATE_INPROCESS, now, pid);
    }

    finishedLock(started: number): MainSyncLock {
        return new MainSyncLock(LOCK_STATE_FINISHED, started, 0);
    }

    /**
     * The SLOW path for ONE branch: the branch checked out in `repoRoot`. Runs its own fetch and its
     * own `gh` query, so it is the right entry point for a single-worktree caller and for tests.
     * The refresher uses computeAllMainSyncStatuses instead — see there for why.
     */
    computeMainSyncStatus(repoRoot: string): MainSyncStatus {
        // Best-effort network refresh; offline just means we evaluate against the last-fetched ref.
        this.fetchOriginMain(repoRoot);
        return this.computeBranchStatus(repoRoot, this.gitBranch(repoRoot), this.loadPullRequestIndex(repoRoot));
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
    computeAllMainSyncStatuses(repoRoot: string): MainSyncStatusFile {
        this.fetchOriginMain(repoRoot);
        const index = this.loadPullRequestIndex(repoRoot);
        const branches: Record<string, MainSyncStatus> = {};
        for (const tree of this.worktrees.listWorktrees(repoRoot)) {
            // Detached HEAD (and a bare worktree) has no branch to key an entry on. Skipping it must
            // not stop the others being recorded, which is why this is a `continue`, not a bail-out.
            if (tree.branch === '' || this.hasBranch(branches, tree.branch)) continue;
            branches[tree.branch] = this.computeBranchStatus(tree.path, tree.branch, index);
        }
        // `main` always present, even with no worktree on it: read-stale-guard's state A looks itself
        // up under 'main', and an absent entry there would silently disarm the stale-main block.
        if (!this.hasBranch(branches, 'main')) branches['main'] = this.mainOnlyStatus(repoRoot);
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
    private computeBranchStatus(repoRoot: string, branch: string, index: PullRequestIndex): MainSyncStatus {
        return this.stampForge(this.computeBranchStatusInner(repoRoot, branch, index), index);
    }

    // Every return path of the computation below has to carry the forge flag, and threading it through
    // four constructions is how one of them would end up missing it. One wrapper, one assignment.
    private stampForge(status: MainSyncStatus, index: PullRequestIndex): MainSyncStatus {
        status.forgeReachable = index.forgeReachable;
        return status;
    }

    // webpieces-disable max-lines-new-methods -- one cohesive slow-path computation
    private computeBranchStatusInner(repoRoot: string, branch: string, index: PullRequestIndex): MainSyncStatus {
        const mergedPr = index.mergedFor(branch);
        const openPr = index.openFor(branch);

        const head = this.capture(repoRoot, 'git', ['rev-parse', 'HEAD']);
        const originMain = this.capture(repoRoot, 'git', ['rev-parse', 'origin/main']);
        const localMain = this.localMainHash(repoRoot);
        const featureHead = head.ok ? head.out : '';
        if (!head.ok || !originMain.ok) {
            const status = this.benignStatus(branch, featureHead);
            status.branchAlreadyMerged = mergedPr !== '';
            status.mergedPr = mergedPr;
            status.openPr = openPr;
            status.localMain = localMain;
            return status;
        }

        const forkPoint = this.capture(repoRoot, 'git', ['merge-base', 'origin/main', 'HEAD']);
        if (!forkPoint.ok || forkPoint.out === '') {
            const noFork = new MainSyncStatus(branch, mergedPr !== '', mergedPr, false, null, originMain.out, featureHead, false, [], new Date().toISOString());
            noFork.openPr = openPr;
            noFork.localMain = localMain;
            return noFork;
        }

        const featureFiles = new Set(this.featureChangedFiles(repoRoot, forkPoint.out));
        const mainFiles = this.changedFiles(repoRoot, forkPoint.out, 'origin/main');
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
    stampCleanMainSyncStatus(repoRoot: string): void {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            const branch = this.gitBranch(repoRoot);
            const originMain = this.capture(repoRoot, 'git', ['rev-parse', 'origin/main']);
            const featureHead = this.capture(repoRoot, 'git', ['rev-parse', 'HEAD']);
            if (!originMain.ok || !featureHead.ok) return;
            const status = new MainSyncStatus(
                branch, false, '', true, originMain.out, originMain.out, featureHead.out, false, [], new Date().toISOString(),
            );
            status.localMain = this.localMainHash(repoRoot);
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
    private fetchOriginMain(repoRoot: string): void {
        const safe = spawnSync('git', ['fetch', '--no-write-fetch-head', 'origin', 'main'], {
            cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'],
        });
        if (safe.status === 0) return;
        if (!this.isUnknownGitOption(safe.stderr)) return;  // a real failure (offline, auth) — not our business
        spawnSync('git', ['fetch', 'origin', 'main'], { cwd: repoRoot, stdio: 'ignore' });
    }

    // Did git reject the flag itself (too old), as opposed to failing the network refresh?
    private isUnknownGitOption(stderr: string | null): boolean {
        const text = (stderr ?? '').toLowerCase();
        return text.includes('unknown option') || text.includes('unknown switch') || text.includes('unrecognized option');
    }

    private ensureDir(filePath: string): void {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
    }

    // Liveness probe: is `pid` still a running process? pid <= 0 (unknown) → assume alive.
    private isProcessAlive(pid: number): boolean {
        if (pid <= 0) return true;
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            process.kill(pid, 0);
            return true;
        } catch (err: unknown) {
            const error = toError(err);
            return !error.message.includes('ESRCH');
        }
    }

    // Run a command capturing trimmed stdout; ok=false on spawn failure or non-zero exit.
    private capture(repoRoot: string, cmd: string, args: string[]): CmdCapture {
        const result = spawnSync(cmd, args, { cwd: repoRoot, encoding: 'utf8' });
        if (result.status !== 0 || typeof result.stdout !== 'string') return { ok: false, out: '' };
        return { ok: true, out: result.stdout.trim() };
    }

    // The actual checked-out branch in repoRoot — cwd-correct so the cache's `branch` label matches.
    private gitBranch(repoRoot: string): string {
        const result = this.capture(repoRoot, 'git', ['rev-parse', '--abbrev-ref', 'HEAD']);
        return result.ok ? result.out : '';
    }

    // The LOCAL main hash. `refs/heads/main` (not the bare name) so it can never resolve to a remote
    // ref or a tag. '' when main does not exist locally — which the guard treats as fail-open.
    private localMainHash(repoRoot: string): string {
        const result = this.capture(repoRoot, 'git', ['rev-parse', 'refs/heads/main']);
        return result.ok ? result.out : '';
    }

    private changedFiles(repoRoot: string, base: string, head: string): string[] {
        const result = this.capture(repoRoot, 'git', ['diff', '--name-only', base, head]);
        if (!result.ok || result.out === '') return [];
        return result.out.split('\n').map((line: string): string => line.trim()).filter((line: string): boolean => line.length > 0);
    }

    // Every file this feature branch has touched since the fork point — committed AND still in the
    // working tree (staged / unstaged / untracked), so a conflict is visible WHILE editing.
    private featureChangedFiles(repoRoot: string, forkPoint: string): string[] {
        const out = new Set<string>();
        const add = (args: string[]): void => {
            const r = this.capture(repoRoot, 'git', args);
            if (!r.ok || r.out === '') return;
            for (const line of r.out.split('\n')) {
                const f = line.trim();
                if (f.length > 0) out.add(f);
            }
        };
        add(['diff', '--name-only', forkPoint, 'HEAD']);      // committed since the fork point
        add(['diff', '--name-only', 'HEAD']);                 // unstaged working-tree edits
        add(['diff', '--name-only', '--cached', 'HEAD']);     // staged edits
        add(['ls-files', '--others', '--exclude-standard']);  // untracked new files (respects .gitignore)
        return [...out];
    }

    /**
     * ONE repo-wide `gh pr list` giving every branch's merged/open PR — replaces the two per-branch
     * `--head <branch>` queries. `--limit 200` bounds it; a branch whose only PR is older than that
     * falls out of the index and reads as "no PR", which is the fail-OPEN direction (no merged PR =
     * no block), the same way a missing `gh` or an offline machine already degraded.
     */
    private loadPullRequestIndex(repoRoot: string): PullRequestIndex {
        const result = this.capture(repoRoot, 'gh', [
            'pr', 'list', '--state', 'all', '--json', 'number,headRefName,state', '--limit', '200',
        ]);
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
    private mainOnlyStatus(repoRoot: string): MainSyncStatus {
        const originMain = this.capture(repoRoot, 'git', ['rev-parse', 'origin/main']);
        const localMain = this.localMainHash(repoRoot);
        const status = new MainSyncStatus(
            'main', false, '', true, localMain === '' ? null : localMain,
            originMain.ok ? originMain.out : '', localMain, false, [], new Date().toISOString(),
        );
        status.localMain = localMain;
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
export function mainSyncLockPath(repoRoot: string): string { return mainSyncSvc.mainSyncLockPath(repoRoot); }
// webpieces-disable no-function-outside-class -- temporary back-compat delegator to MainSyncStatusService; removed once consumers inject it
export function readMainSyncStatus(repoRoot: string, branch: string): MainSyncStatus | null { return mainSyncSvc.readMainSyncStatus(repoRoot, branch); }
// webpieces-disable no-function-outside-class -- temporary back-compat delegator to MainSyncStatusService; removed once consumers inject it
export function readMainSyncStatusFile(repoRoot: string): MainSyncStatusFile | null { return mainSyncSvc.readMainSyncStatusFile(repoRoot); }
// webpieces-disable no-function-outside-class -- temporary back-compat delegator to MainSyncStatusService; removed once consumers inject it
export function writeMainSyncStatus(repoRoot: string, status: MainSyncStatus): void { mainSyncSvc.writeMainSyncStatus(repoRoot, status); }
// webpieces-disable no-function-outside-class -- temporary back-compat delegator to MainSyncStatusService; removed once consumers inject it
export function writeMainSyncStatusFile(repoRoot: string, file: MainSyncStatusFile): void { mainSyncSvc.writeMainSyncStatusFile(repoRoot, file); }
// webpieces-disable no-function-outside-class -- temporary back-compat delegator to MainSyncStatusService; removed once consumers inject it
export function readMainSyncLock(repoRoot: string): MainSyncLock | null { return mainSyncSvc.readMainSyncLock(repoRoot); }
// webpieces-disable no-function-outside-class -- temporary back-compat delegator to MainSyncStatusService; removed once consumers inject it
export function writeMainSyncLock(repoRoot: string, lock: MainSyncLock): void { mainSyncSvc.writeMainSyncLock(repoRoot, lock); }
// webpieces-disable no-function-outside-class -- temporary back-compat delegator to MainSyncStatusService; removed once consumers inject it
export function isLockStale(lock: MainSyncLock, hangTimeoutMinutes: number, now: number = Date.now()): boolean { return mainSyncSvc.isLockStale(lock, hangTimeoutMinutes, now); }
// webpieces-disable no-function-outside-class -- temporary back-compat delegator to MainSyncStatusService; removed once consumers inject it
export function isRefreshInProgress(repoRoot: string, hangTimeoutMinutes: number, now: number = Date.now()): boolean { return mainSyncSvc.isRefreshInProgress(repoRoot, hangTimeoutMinutes, now); }
// webpieces-disable no-function-outside-class -- temporary back-compat delegator to MainSyncStatusService; removed once consumers inject it
export function tryAcquireMainSyncLock(repoRoot: string, hangTimeoutMinutes: number, now: number = Date.now(), pid: number = process.pid): MainSyncLock | null { return mainSyncSvc.tryAcquireMainSyncLock(repoRoot, hangTimeoutMinutes, now, pid); }
// webpieces-disable no-function-outside-class -- temporary back-compat delegator to MainSyncStatusService; removed once consumers inject it
export function inProcessLock(now: number = Date.now(), pid: number = process.pid): MainSyncLock { return mainSyncSvc.inProcessLock(now, pid); }
// webpieces-disable no-function-outside-class -- temporary back-compat delegator to MainSyncStatusService; removed once consumers inject it
export function finishedLock(started: number): MainSyncLock { return mainSyncSvc.finishedLock(started); }
// webpieces-disable no-function-outside-class -- temporary back-compat delegator to MainSyncStatusService; removed once consumers inject it
export function computeMainSyncStatus(repoRoot: string): MainSyncStatus { return mainSyncSvc.computeMainSyncStatus(repoRoot); }
// webpieces-disable no-function-outside-class -- temporary back-compat delegator to MainSyncStatusService; removed once consumers inject it
export function computeAllMainSyncStatuses(repoRoot: string): MainSyncStatusFile { return mainSyncSvc.computeAllMainSyncStatuses(repoRoot); }
// webpieces-disable no-function-outside-class -- temporary back-compat delegator to MainSyncStatusService; removed once consumers inject it
export function squashRecoverySteps(currentBranch: string): string[] { return mainSyncSvc.squashRecoverySteps(currentBranch); }
// webpieces-disable no-function-outside-class -- temporary back-compat delegator to MainSyncStatusService; removed once consumers inject it
export function stampCleanMainSyncStatus(repoRoot: string): void { mainSyncSvc.stampCleanMainSyncStatus(repoRoot); }
