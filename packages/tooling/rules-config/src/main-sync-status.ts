import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { WEBPIECES_TMP_DIR } from './constants';
import { toError } from './to-error';

// Shared "is my feature branch healthy relative to origin/main?" state. The SLOW signals (git fetch
// + merge-base + same-file-overlap + a merged-PR lookup) are computed by the ai-hook-rules refresher
// in a DETACHED background process so the PreToolUse hook never blocks on the network. The
// feature-branch-guard then only READS this cached file (instant). pr-gate's merge flow also writes
// it synchronously after a merge so the next edit is unblocked immediately. Lives here (the shared
// dep of both packages) so neither depends on the other.

// How long an `inprocess` refresher lock may sit before a new refresher assumes the prior run hung
// and proceeds anyway. Overridable per-rule via FeatureBranchGuardConfig.hangTimeoutMinutes.
export const DEFAULT_HANG_TIMEOUT_MINUTES = 5;

const MAIN_SYNC_STATUS_FILE = 'main-sync-status.json';
const MAIN_SYNC_LOCK_FILE = 'main-sync.lock.json';

const LOCK_STATE_INPROCESS = 'inprocess';
const LOCK_STATE_FINISHED = 'finished';

// Data-only (per CLAUDE.md, classes for data). `forkPoint` is null exactly when `hasForkPoint` is
// false (no merge-base with origin/main). `branchAlreadyMerged` flags that this feature branch was
// already merged into main (a merged PR exists) — the "you're working on a finished branch" case.
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

// Concurrency state machine for the detached refresher. `started` is epoch milliseconds.
export class MainSyncLock {
    state: string;
    started: number;

    constructor(state: string, started: number) {
        this.state = state;
        this.started = started;
    }
}

// Raw JSON shapes for the cast at the parse boundary —
// keeps `any`/`unknown` out of the cast so no-any-unknown stays clean.
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
}

interface RawLock {
    state?: string;
    started?: number;
}

// Result of a captured git/gh invocation: ok=false on spawn failure or non-zero exit.
interface CmdCapture {
    ok: boolean;
    out: string;
}

export function mainSyncStatusPath(repoRoot: string): string {
    return path.join(repoRoot, WEBPIECES_TMP_DIR, MAIN_SYNC_STATUS_FILE);
}

export function mainSyncLockPath(repoRoot: string): string {
    return path.join(repoRoot, WEBPIECES_TMP_DIR, MAIN_SYNC_LOCK_FILE);
}

function ensureDir(filePath: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

// Pure read — any error (missing file, malformed JSON) returns null so the guard fails OPEN
// (never block an edit because the cache is unreadable).
export function readMainSyncStatus(repoRoot: string): MainSyncStatus | null {
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        const statusPath = mainSyncStatusPath(repoRoot);
        if (!fs.existsSync(statusPath)) return null;
        const raw = JSON.parse(fs.readFileSync(statusPath, 'utf8')) as RawStatus;
        return new MainSyncStatus(
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
    } catch (err: unknown) {
        const error = toError(err);
        void error;
        return null;
    }
}

export function writeMainSyncStatus(repoRoot: string, status: MainSyncStatus): void {
    const statusPath = mainSyncStatusPath(repoRoot);
    ensureDir(statusPath);
    fs.writeFileSync(statusPath, JSON.stringify(status, null, 2) + '\n');
}

export function readMainSyncLock(repoRoot: string): MainSyncLock | null {
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        const lockPath = mainSyncLockPath(repoRoot);
        if (!fs.existsSync(lockPath)) return null;
        const raw = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as RawLock;
        return new MainSyncLock(raw.state ?? LOCK_STATE_FINISHED, raw.started ?? 0);
    } catch (err: unknown) {
        const error = toError(err);
        void error;
        return null;
    }
}

export function writeMainSyncLock(repoRoot: string, lock: MainSyncLock): void {
    const lockPath = mainSyncLockPath(repoRoot);
    ensureDir(lockPath);
    fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');
}

// A lock is stale (the prior refresher is assumed hung) once it has been `inprocess` longer than
// hangTimeoutMinutes. `now` is injectable for tests; defaults to Date.now().
export function isLockStale(lock: MainSyncLock, hangTimeoutMinutes: number, now: number = Date.now()): boolean {
    return now - lock.started > hangTimeoutMinutes * 60 * 1000;
}

// True when another refresher is actively running and we should NOT start a second one. A finished
// lock, a missing lock, or a stale (hung) inprocess lock all return false.
export function isRefreshInProgress(repoRoot: string, hangTimeoutMinutes: number, now: number = Date.now()): boolean {
    const lock = readMainSyncLock(repoRoot);
    if (!lock) return false;
    if (lock.state !== LOCK_STATE_INPROCESS) return false;
    return !isLockStale(lock, hangTimeoutMinutes, now);
}

export function inProcessLock(now: number = Date.now()): MainSyncLock {
    return new MainSyncLock(LOCK_STATE_INPROCESS, now);
}

export function finishedLock(started: number): MainSyncLock {
    return new MainSyncLock(LOCK_STATE_FINISHED, started);
}

// Run a command capturing trimmed stdout; ok=false on spawn failure or non-zero exit.
function capture(repoRoot: string, cmd: string, args: string[]): CmdCapture {
    const result = spawnSync(cmd, args, { cwd: repoRoot, encoding: 'utf8' });
    if (result.status !== 0 || typeof result.stdout !== 'string') return { ok: false, out: '' };
    return { ok: true, out: result.stdout.trim() };
}

// The actual checked-out branch in repoRoot — cwd-correct so the cache's `branch` label always
// matches what the feature-branch-guard compares against (its own `git rev-parse` in the workspace).
function gitBranch(repoRoot: string): string {
    const result = capture(repoRoot, 'git', ['rev-parse', '--abbrev-ref', 'HEAD']);
    return result.ok ? result.out : '';
}

function changedFiles(repoRoot: string, base: string, head: string): string[] {
    const result = capture(repoRoot, 'git', ['diff', '--name-only', base, head]);
    if (!result.ok || result.out === '') return [];
    return result.out.split('\n').map((line: string): string => line.trim()).filter((line: string): boolean => line.length > 0);
}

// Has this feature branch already been merged into main? Reliable signal: a MERGED PR exists for the
// branch. Best-effort — if gh is missing/unauthenticated we just report not-merged (false).
function detectMergedPr(repoRoot: string, branch: string): string {
    if (!branch || branch === 'main') return '';
    const result = capture(repoRoot, 'gh', ['pr', 'list', '--head', branch, '--state', 'merged', '--json', 'number', '--jq', '.[0].number']);
    return result.ok ? result.out : '';
}

// A benign status that never blocks — used when origin/main can't be resolved (no remote yet,
// offline before first fetch). hasForkPoint=true + conflict=false so the guard allows the edit.
function benignStatus(branch: string, featureHead: string): MainSyncStatus {
    return new MainSyncStatus(branch, false, '', true, null, '', featureHead, false, [], new Date().toISOString());
}

/**
 * The SLOW path, run only inside the detached refresher. Computes every cached signal the
 * feature-branch-guard needs: whether the branch is already merged (merged PR), whether a fork point
 * with origin/main still exists, and whether origin/main and this branch touched the SAME file since
 * the fork point (the deliberately-simple conflict heuristic — it over-blocks rather than miss a real
 * conflict). Never run on the hook's blocking path.
 */
export function computeMainSyncStatus(repoRoot: string): MainSyncStatus {
    const branch = gitBranch(repoRoot);
    const mergedPr = detectMergedPr(repoRoot, branch);

    // Best-effort network refresh; offline just means we evaluate against the last-fetched ref.
    spawnSync('git', ['fetch', 'origin', 'main'], { cwd: repoRoot, stdio: 'ignore' });

    const head = capture(repoRoot, 'git', ['rev-parse', 'HEAD']);
    const originMain = capture(repoRoot, 'git', ['rev-parse', 'origin/main']);
    const featureHead = head.ok ? head.out : '';
    if (!head.ok || !originMain.ok) {
        const status = benignStatus(branch, featureHead);
        status.branchAlreadyMerged = mergedPr !== '';
        status.mergedPr = mergedPr;
        return status;
    }

    const forkPoint = capture(repoRoot, 'git', ['merge-base', 'origin/main', 'HEAD']);
    if (!forkPoint.ok || forkPoint.out === '') {
        // No common ancestor — main was merged into the branch. Force the human to squash.
        return new MainSyncStatus(branch, mergedPr !== '', mergedPr, false, null, originMain.out, featureHead, false, [], new Date().toISOString());
    }

    const featureFiles = new Set(changedFiles(repoRoot, forkPoint.out, 'HEAD'));
    const mainFiles = changedFiles(repoRoot, forkPoint.out, 'origin/main');
    const conflictFiles = mainFiles.filter((file: string): boolean => featureFiles.has(file));

    return new MainSyncStatus(
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
}

// The recovery steps when there is no fork point with origin/main (someone merged main into the
// branch, so a clean squash-merge is impossible). Shared so the feature-branch-guard and pr-gate's
// findForkPoint check present the SAME instructions. The human must redo the work on a fresh branch —
// deliberately painful so the bad merge gets noticed and reported.
export function squashRecoverySteps(currentBranch: string): string[] {
    return [
        '1. Switch to main:            git checkout main',
        '2. Pull latest:               git pull',
        `3. New branch (new name):     git checkout -b ${currentBranch}-v2`,
        `4. Squash-merge old branch:   git merge --squash ${currentBranch}`,
        `5. Commit the squash:         git add -A && git commit -m "Squashed from ${currentBranch}"`,
        '6. If a PR exists:            open a NEW PR for the -v2 branch and close the old one.',
    ];
}

// Synchronously stamp a clean "up to date with main" status — call right after a successful merge
// (the branch now contains origin/main). Unblocks the next edit immediately without waiting for the
// async refresher. Best-effort: a git failure is swallowed (the refresher will recompute later).
export function stampCleanMainSyncStatus(repoRoot: string): void {
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        const branch = gitBranch(repoRoot);
        const originMain = capture(repoRoot, 'git', ['rev-parse', 'origin/main']);
        const featureHead = capture(repoRoot, 'git', ['rev-parse', 'HEAD']);
        if (!originMain.ok || !featureHead.ok) return;
        const status = new MainSyncStatus(
            branch, false, '', true, originMain.out, originMain.out, featureHead.out, false, [], new Date().toISOString(),
        );
        writeMainSyncStatus(repoRoot, status);
    } catch (err: unknown) {
        const error = toError(err);
        void error;
    }
}
