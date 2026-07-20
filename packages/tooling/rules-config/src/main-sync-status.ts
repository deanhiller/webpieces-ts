import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { injectable, bindingScopeValues } from 'inversify';

import { WEBPIECES_TMP_DIR } from './constants';
import { toError } from './to-error';

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

// Data-only (per CLAUDE.md, classes for data).
export class MainSyncStatus {
    branch: string;
    branchAlreadyMerged: boolean;
    mergedPr: string;
    hasForkPoint: boolean;
    forkPoint: string | null;
    originMain: string;
    featureHead: string;
    conflict: boolean;
    conflictFiles: string[];
    timestamp: string;
    // An OPEN (not merged) PR tracking this branch, if any — '' = none or not-yet-known. Advisory.
    // Kept OUT of the positional constructor (a defaulted field) so existing call sites don't churn.
    openPr: string = '';
    // The LOCAL refs/heads/main hash — '' = main does not exist locally (fresh clone / worktree) or
    // could not be read. Paired with `originMain`, this is what tells the main-stale-guard whether a
    // checked-out `main` is behind its remote. Defaulted field for the same reason as `openPr`.
    localMain: string = '';

    constructor(
        branch: string,
        branchAlreadyMerged: boolean,
        mergedPr: string,
        hasForkPoint: boolean,
        forkPoint: string | null,
        originMain: string,
        featureHead: string,
        conflict: boolean,
        conflictFiles: string[],
        timestamp: string,
    ) {
        this.branch = branch;
        this.branchAlreadyMerged = branchAlreadyMerged;
        this.mergedPr = mergedPr;
        this.hasForkPoint = hasForkPoint;
        this.forkPoint = forkPoint;
        this.originMain = originMain;
        this.featureHead = featureHead;
        this.conflict = conflict;
        this.conflictFiles = conflictFiles;
        this.timestamp = timestamp;
    }
}

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

// Raw JSON shapes for the cast at the parse boundary.
interface RawStatus {
    branch?: string;
    branchAlreadyMerged?: boolean;
    mergedPr?: string;
    hasForkPoint?: boolean;
    forkPoint?: string | null;
    originMain?: string;
    featureHead?: string;
    conflict?: boolean;
    conflictFiles?: string[];
    timestamp?: string;
    openPr?: string;
    localMain?: string;
}

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
    mainSyncStatusPath(repoRoot: string): string {
        return path.join(repoRoot, WEBPIECES_TMP_DIR, MAIN_SYNC_STATUS_FILE);
    }

    mainSyncLockPath(repoRoot: string): string {
        return path.join(repoRoot, WEBPIECES_TMP_DIR, MAIN_SYNC_LOCK_FILE);
    }

    // Pure read — any error (missing file, malformed JSON) returns null so the guard fails OPEN.
    readMainSyncStatus(repoRoot: string): MainSyncStatus | null {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            const statusPath = this.mainSyncStatusPath(repoRoot);
            if (!fs.existsSync(statusPath)) return null;
            const raw = JSON.parse(fs.readFileSync(statusPath, 'utf8')) as RawStatus;
            const status = new MainSyncStatus(
                raw.branch ?? '',
                raw.branchAlreadyMerged ?? false,
                raw.mergedPr ?? '',
                raw.hasForkPoint ?? true,
                raw.forkPoint ?? null,
                raw.originMain ?? '',
                raw.featureHead ?? '',
                raw.conflict ?? false,
                raw.conflictFiles ?? [],
                raw.timestamp ?? '',
            );
            status.openPr = raw.openPr ?? '';
            status.localMain = raw.localMain ?? '';
            return status;
        } catch (err: unknown) {
            const error = toError(err);
            void error;
            return null;
        }
    }

    writeMainSyncStatus(repoRoot: string, status: MainSyncStatus): void {
        const statusPath = this.mainSyncStatusPath(repoRoot);
        this.ensureDir(statusPath);
        fs.writeFileSync(statusPath, JSON.stringify(status, null, 2) + '\n');
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

    inProcessLock(now: number = Date.now(), pid: number = process.pid): MainSyncLock {
        return new MainSyncLock(LOCK_STATE_INPROCESS, now, pid);
    }

    finishedLock(started: number): MainSyncLock {
        return new MainSyncLock(LOCK_STATE_FINISHED, started, 0);
    }

    /**
     * The SLOW path, run only inside the detached refresher. Computes every cached signal the
     * feature-branch-guard needs. Never run on the hook's blocking path.
     */
    // webpieces-disable max-lines-new-methods -- one cohesive slow-path computation
    computeMainSyncStatus(repoRoot: string): MainSyncStatus {
        const branch = this.gitBranch(repoRoot);
        const mergedPr = this.detectMergedPr(repoRoot, branch);
        const openPr = this.detectOpenPr(repoRoot, branch);

        // Best-effort network refresh; offline just means we evaluate against the last-fetched ref.
        spawnSync('git', ['fetch', 'origin', 'main'], { cwd: repoRoot, stdio: 'ignore' });

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
            '   tell you to use `pnpm wp-start-update` (3-point merge) instead.',
            `4. Commit the squash:            git add -A && git commit -m "Squashed from ${currentBranch}"`,
            '5. If a PR exists:               open a NEW PR for the -v2 branch and close the old one.',
        ];
    }

    // Synchronously stamp a clean "up to date with main" status — call right after a successful merge.
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

    // Has this feature branch already been merged into main? Reliable signal: a MERGED PR exists.
    private detectMergedPr(repoRoot: string, branch: string): string {
        if (!branch || branch === 'main') return '';
        const result = this.capture(repoRoot, 'gh', ['pr', 'list', '--head', branch, '--state', 'merged', '--json', 'number', '--jq', '.[0].number']);
        return result.ok ? result.out : '';
    }

    // An OPEN PR tracking this branch, if any. Best-effort/advisory.
    private detectOpenPr(repoRoot: string, branch: string): string {
        if (!branch || branch === 'main') return '';
        const result = this.capture(repoRoot, 'gh', ['pr', 'list', '--head', branch, '--state', 'open', '--json', 'number', '--jq', '.[0].number']);
        return result.ok ? result.out : '';
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
export function readMainSyncStatus(repoRoot: string): MainSyncStatus | null { return mainSyncSvc.readMainSyncStatus(repoRoot); }
// webpieces-disable no-function-outside-class -- temporary back-compat delegator to MainSyncStatusService; removed once consumers inject it
export function writeMainSyncStatus(repoRoot: string, status: MainSyncStatus): void { mainSyncSvc.writeMainSyncStatus(repoRoot, status); }
// webpieces-disable no-function-outside-class -- temporary back-compat delegator to MainSyncStatusService; removed once consumers inject it
export function readMainSyncLock(repoRoot: string): MainSyncLock | null { return mainSyncSvc.readMainSyncLock(repoRoot); }
// webpieces-disable no-function-outside-class -- temporary back-compat delegator to MainSyncStatusService; removed once consumers inject it
export function writeMainSyncLock(repoRoot: string, lock: MainSyncLock): void { mainSyncSvc.writeMainSyncLock(repoRoot, lock); }
// webpieces-disable no-function-outside-class -- temporary back-compat delegator to MainSyncStatusService; removed once consumers inject it
export function isLockStale(lock: MainSyncLock, hangTimeoutMinutes: number, now: number = Date.now()): boolean { return mainSyncSvc.isLockStale(lock, hangTimeoutMinutes, now); }
// webpieces-disable no-function-outside-class -- temporary back-compat delegator to MainSyncStatusService; removed once consumers inject it
export function isRefreshInProgress(repoRoot: string, hangTimeoutMinutes: number, now: number = Date.now()): boolean { return mainSyncSvc.isRefreshInProgress(repoRoot, hangTimeoutMinutes, now); }
// webpieces-disable no-function-outside-class -- temporary back-compat delegator to MainSyncStatusService; removed once consumers inject it
export function inProcessLock(now: number = Date.now(), pid: number = process.pid): MainSyncLock { return mainSyncSvc.inProcessLock(now, pid); }
// webpieces-disable no-function-outside-class -- temporary back-compat delegator to MainSyncStatusService; removed once consumers inject it
export function finishedLock(started: number): MainSyncLock { return mainSyncSvc.finishedLock(started); }
// webpieces-disable no-function-outside-class -- temporary back-compat delegator to MainSyncStatusService; removed once consumers inject it
export function computeMainSyncStatus(repoRoot: string): MainSyncStatus { return mainSyncSvc.computeMainSyncStatus(repoRoot); }
// webpieces-disable no-function-outside-class -- temporary back-compat delegator to MainSyncStatusService; removed once consumers inject it
export function squashRecoverySteps(currentBranch: string): string[] { return mainSyncSvc.squashRecoverySteps(currentBranch); }
// webpieces-disable no-function-outside-class -- temporary back-compat delegator to MainSyncStatusService; removed once consumers inject it
export function stampCleanMainSyncStatus(repoRoot: string): void { mainSyncSvc.stampCleanMainSyncStatus(repoRoot); }
