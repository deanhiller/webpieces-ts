import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { DotWebpieces, WORKTREE_STATE_DIR } from './state-dir';
import { StateDirMigrator } from './state-dir-migration';
import { MainSyncStatusService, MainSyncLock } from './main-sync-status';

function git(cwd: string, cmd: string): string {
    return execSync(`git -c core.hooksPath=/dev/null ${cmd}`, {
        cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
}

function writeFile(root: string, relPath: string, content: string): void {
    const full = path.join(root, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
}

/**
 * The migration is the part that can destroy real work, so it is tested against a real linked worktree
 * holding a real in-flight merge — the exact situation that existed in a sibling worktree when this
 * change was written.
 */
// Shared fixture: a primary clone with one linked worktree, plus that worktree's namespace path.
let tmp: string;
let primary: string;
let worktree: string;
let namespace: string;

function makeMigrationRepo(): void {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dotwp-mig-')));
    primary = path.join(tmp, 'primary');
    worktree = path.join(tmp, 'wt-inflight');
    fs.mkdirSync(primary, { recursive: true });
    git(primary, 'init -q -b main');
    git(primary, 'config user.email test@example.com');
    git(primary, 'config user.name Test');
    writeFile(primary, 'webpieces.config.json', '{}\n');
    git(primary, 'add -A');
    git(primary, 'commit -q -m init');
    git(primary, `worktree add -q -b feature ${worktree}`);
    namespace = path.join(primary, '.webpieces', WORKTREE_STATE_DIR, 'wt-inflight');
}

function cleanupMigrationRepo(): void {
    fs.rmSync(tmp, { recursive: true, force: true });
}

describe('legacy per-worktree .webpieces migration', () => {
    beforeEach(() => { makeMigrationRepo(); });
    afterEach(cleanupMigrationRepo);

    it('moves an IN-FLIGHT merge out of the legacy dir without losing a byte', () => {
        const marker = 'merge-info/staged/feature/merge-in-progress.json';
        writeFile(worktree, `.webpieces/${marker}`, '{"validated":false,"conflictedFiles":["a.ts"]}');
        writeFile(worktree, '.webpieces/pr-review/feature/review.json', '{"title":"wip"}');

        // Resolution itself performs the migration — the first new-code process in this worktree.
        const resolved = new DotWebpieces().local(worktree);

        expect(resolved).toBe(namespace);
        expect(fs.readFileSync(path.join(namespace, marker), 'utf8'))
            .toBe('{"validated":false,"conflictedFiles":["a.ts"]}');
        expect(fs.readFileSync(path.join(namespace, 'pr-review/feature/review.json'), 'utf8'))
            .toBe('{"title":"wip"}');
        // The drained legacy dir removes itself, so nothing is left to diverge from.
        expect(fs.existsSync(path.join(worktree, '.webpieces'))).toBe(false);
    });

    it('NEVER destroys or overwrites: an occupied destination leaves the legacy copy in place', () => {
        const relative = 'merge-info/staged/feature/merge-in-progress.json';
        writeFile(namespace, relative, '{"which":"already-in-namespace"}');
        writeFile(worktree, `.webpieces/${relative}`, '{"which":"legacy"}');

        const report = new StateDirMigrator().migrate(
            path.join(worktree, '.webpieces'), namespace);

        expect(report.kept).toContain(relative);
        expect(fs.readFileSync(path.join(namespace, relative), 'utf8')).toBe('{"which":"already-in-namespace"}');
        // The loser is still on disk, untouched, for a human to reconcile.
        expect(fs.readFileSync(path.join(worktree, '.webpieces', relative), 'utf8')).toBe('{"which":"legacy"}');
    });

});

describe('legacy .webpieces migration — partial and repeat runs', () => {
    beforeEach(() => { makeMigrationRepo(); });
    afterEach(cleanupMigrationRepo);

    it('merges around an occupied path — free siblings still move', () => {
        writeFile(namespace, 'merge-info/staged/feature/merge-in-progress.json', '{"which":"kept"}');
        writeFile(worktree, '.webpieces/merge-info/staged/feature/merge-in-progress.json', '{"which":"legacy"}');
        writeFile(worktree, '.webpieces/hooks/branch-mutations.log', 'one audit line\n');

        const report = new StateDirMigrator().migrate(path.join(worktree, '.webpieces'), namespace);

        // `hooks/` had a free destination, so the WHOLE subtree moved in one rename — that is the
        // property that keeps an in-flight merge from ever being half-migrated.
        expect(report.moved).toContain('hooks');
        expect(fs.readFileSync(path.join(namespace, 'hooks/branch-mutations.log'), 'utf8'))
            .toBe('one audit line\n');
    });

    /**
     * The PUBLISHED-vs-LOCAL transition window: an old build writes the old path while new builds write
     * the new one. Each new-code process migrates on first resolution, so state deposited by old code is
     * swept in before anything reads it — the two schemes converge instead of splitting.
     */
    it('sweeps state deposited by an OLD published build on the next new-code resolution', () => {
        new DotWebpieces().local(worktree);                       // new code runs first, dir is clean
        writeFile(worktree, '.webpieces/pr-review/feature/pr-body.md', 'written by the old build\n');

        const resolved = new DotWebpieces().local(worktree);      // a LATER process (fresh instance)

        expect(resolved).toBe(namespace);
        expect(fs.readFileSync(path.join(namespace, 'pr-review/feature/pr-body.md'), 'utf8'))
            .toBe('written by the old build\n');
    });

    it('is a no-op in the primary clone — its .webpieces is already the right place', () => {
        writeFile(primary, '.webpieces/merge-info/staged/main/merge-in-progress.json', '{"primary":true}');
        expect(new DotWebpieces().local(primary)).toBe(path.join(primary, '.webpieces'));
        expect(fs.readFileSync(
            path.join(primary, '.webpieces/merge-info/staged/main/merge-in-progress.json'), 'utf8'))
            .toBe('{"primary":true}');
    });
});

/**
 * SINGLE-FLIGHT. The lock now lives in the primary clone, so worktrees contend for ONE lock — which is
 * the whole point: there is one `.git`, and N concurrent `git fetch`es against it is what corrupts
 * FETCH_HEAD (see the filed bug). The lock mechanism itself (O_CREAT|O_EXCL + pid/age takeover) is
 * pre-existing; what is new is that it is repo-wide.
 */
let worktreeA: string;
let worktreeB: string;
let service: MainSyncStatusService;

function makeTwoWorktreeRepo(): void {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dotwp-lock-')));
    primary = path.join(tmp, 'primary');
    worktreeA = path.join(tmp, 'wt-a');
    worktreeB = path.join(tmp, 'wt-b');
    fs.mkdirSync(primary, { recursive: true });
    git(primary, 'init -q -b main');
    git(primary, 'config user.email test@example.com');
    git(primary, 'config user.name Test');
    writeFile(primary, 'webpieces.config.json', '{}\n');
    git(primary, 'add -A');
    git(primary, 'commit -q -m init');
    git(primary, `worktree add -q -b a ${worktreeA}`);
    git(primary, `worktree add -q -b b ${worktreeB}`);
    service = new MainSyncStatusService(new DotWebpieces());
}

describe('main-sync single-flight across worktrees', () => {
    beforeEach(() => { makeTwoWorktreeRepo(); });
    afterEach(cleanupMigrationRepo);

    it('only ONE of two worktrees acquires the lock — the other must skip and read the status', () => {
        const first = service.tryAcquireMainSyncLock(worktreeA, 5, Date.now(), process.pid);
        const second = service.tryAcquireMainSyncLock(worktreeB, 5, Date.now(), process.pid);

        expect(first).not.toBeNull();
        expect(second).toBeNull();
        // Same physical file from both trees — a per-worktree lock would have let both through.
        expect(service.mainSyncLockPath(worktreeA)).toBe(service.mainSyncLockPath(worktreeB));
        expect(fs.existsSync(path.join(primary, '.webpieces', 'main-sync.lock.json'))).toBe(true);
    });

    it('a STALE lock is recoverable — a hung holder does not wedge every worktree forever', () => {
        const longAgo = Date.now() - 60 * 60 * 1000;
        service.writeMainSyncLock(worktreeA, new MainSyncLock('inprocess', longAgo, process.pid));

        // hangTimeoutMinutes has passed, so the next refresher — in ANOTHER worktree — takes it over.
        const taken = service.tryAcquireMainSyncLock(worktreeB, 5, Date.now(), process.pid);
        expect(taken).not.toBeNull();
    });

});

describe('main-sync lock recovery and status visibility', () => {
    beforeEach(() => { makeTwoWorktreeRepo(); });
    afterEach(cleanupMigrationRepo);

    it('a lock held by a DEAD process is reclaimed immediately, without waiting out the timeout', () => {
        // pid 0x7FFFFFFF is not a live process; the holder is provably gone, so waiting is pointless.
        service.writeMainSyncLock(worktreeA, new MainSyncLock('inprocess', Date.now(), 0x7FFFFFFF));
        expect(service.tryAcquireMainSyncLock(worktreeB, 5, Date.now(), process.pid)).not.toBeNull();
    });

    it('the status file written by the winner is visible from every other worktree', () => {
        const status = service.computeMainSyncStatus(primary);
        service.writeMainSyncStatus(primary, status);
        expect(service.readMainSyncStatus(worktreeB, status.branch)).not.toBeNull();
        expect(service.mainSyncStatusPath(worktreeA)).toBe(service.mainSyncStatusPath(worktreeB));
    });
});

/**
 * hooks/ -> logs/ — the second relocation this migrator performs.
 *
 * Every webpieces `.log` now lives in `logs/`, for the primary clone and every worktree namespace
 * alike. That layout is only worth having if UPGRADING does not orphan the history a human is
 * mid-way through reading, so the move is the same shape and the same safety rule as the worktree
 * migration above: rename what is free, never overwrite, never delete.
 */
describe('hooks/ to logs/ relocation', () => {
    let tmpDir: string;

    beforeEach(() => { tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wp-logsmig-'))); });
    afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

    function stateWithLegacyLogs(): string {
        const state = path.join(tmpDir, '.webpieces');
        writeFile(state, 'hooks/guard-invocations.log', 'old invocation history\n');
        writeFile(state, 'hooks/branch-mutations.log', 'old mutation history\n');
        writeFile(state, 'hooks/2026-08-03/writeInfo-1.md', '# a rejection detail\n');
        return state;
    }

    it('moves every hooks/*.log into logs/ and leaves the NON-log state where it is', () => {
        const state = stateWithLegacyLogs();
        new StateDirMigrator().migrateLogFiles(path.join(state, 'hooks'), path.join(state, 'logs'));

        expect(fs.readFileSync(path.join(state, 'logs/guard-invocations.log'), 'utf8')).toBe('old invocation history\n');
        expect(fs.readFileSync(path.join(state, 'logs/branch-mutations.log'), 'utf8')).toBe('old mutation history\n');
        expect(fs.existsSync(path.join(state, 'hooks/guard-invocations.log'))).toBe(false);
        // The dated rejection details are not logs; a recursive sweep would have dragged them along.
        expect(fs.existsSync(path.join(state, 'hooks/2026-08-03/writeInfo-1.md'))).toBe(true);
    });

    it('never overwrites an occupied destination — the legacy copy is left for a human', () => {
        const state = stateWithLegacyLogs();
        writeFile(state, 'logs/guard-invocations.log', 'newer history\n');

        const report = new StateDirMigrator().migrateLogFiles(path.join(state, 'hooks'), path.join(state, 'logs'));

        expect(report.kept).toContain('guard-invocations.log');
        expect(fs.readFileSync(path.join(state, 'logs/guard-invocations.log'), 'utf8')).toBe('newer history\n');
        expect(fs.readFileSync(path.join(state, 'hooks/guard-invocations.log'), 'utf8')).toBe('old invocation history\n');
    });

    it('is a no-op on a tree that has no legacy hooks/ at all (the common case, forever after)', () => {
        const state = path.join(tmpDir, '.webpieces');
        const report = new StateDirMigrator().migrateLogFiles(path.join(state, 'hooks'), path.join(state, 'logs'));
        expect(report.movedAnything).toBe(false);
        expect(fs.existsSync(path.join(state, 'logs'))).toBe(false);
    });

    it('runs automatically on the first dotWebpieces.logs() call, so no caller has to know', () => {
        const state = stateWithLegacyLogs();
        const resolved = new DotWebpieces().logs(tmpDir);
        expect(resolved).toBe(path.join(state, 'logs'));
        expect(fs.readFileSync(path.join(state, 'logs/branch-mutations.log'), 'utf8')).toBe('old mutation history\n');
    });
});
