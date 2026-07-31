import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { DotWebpieces, WORKTREE_STATE_DIR } from './state-dir';
import { MergedBranchesService } from './merged-branches';
import { MainSyncStatusService } from './main-sync-status';
import { BranchMutationLog, BranchMutationEvent } from './branch-mutation-log';
import { RepoRootFinder } from './repo-root';
import { findConfigFile } from './config-file';

// core.hooksPath=/dev/null: keep any machine-global git hooks out of the throwaway test repos.
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
 * REAL repos with REAL linked worktrees, on purpose: the entire question this resolver answers ("am I
 * in a linked worktree, and where is the primary clone?") is answered by git itself, so a mocked
 * spawnSync would only prove that the mock returns what the mock was told to return.
 */
// Shared mutable fixture for the describes below. A fresh DotWebpieces per test on purpose: the
// resolver caches git's answer per start dir for the life of the process, which is right in production
// and wrong across throwaway repos inside one test file.
let tmp: string;
let primary: string;
let worktree: string;
let dot: DotWebpieces;

function makeRepoWithWorktree(prefix: string, worktreeDirName: string): void {
        // realpathSync: macOS os.tmpdir() is a symlink; git returns the real path, so paths must be
        // compared against the resolved form.
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
    primary = path.join(tmp, 'primary');
    worktree = path.join(tmp, worktreeDirName);
    fs.mkdirSync(primary, { recursive: true });

    git(primary, 'init -q -b main');
    git(primary, 'config user.email test@example.com');
    git(primary, 'config user.name Test');
    writeFile(primary, 'webpieces.config.json', '{}\n');
    writeFile(primary, '.gitignore', '.webpieces/\n');
    git(primary, 'add -A');
    git(primary, 'commit -q -m init');
    git(primary, `worktree add -q -b feature ${worktree}`);

    dot = new DotWebpieces();
}

function cleanupRepo(): void {
    fs.rmSync(tmp, { recursive: true, force: true });
}

describe('DotWebpieces.local()/shared() over a real linked worktree', () => {
    beforeEach(() => { makeRepoWithWorktree('dotwp-', 'wt-feature'); });
    afterEach(cleanupRepo);

    it('local() in a LINKED worktree resolves under the primary clone worktrees/<name>/ namespace', () => {
        // git names the worktree after its directory, and that name is the namespace key.
        expect(dot.isLinkedWorktree(worktree)).toBe(true);
        expect(dot.worktreeName(worktree)).toBe('wt-feature');
        expect(dot.local(worktree)).toBe(
            path.join(primary, '.webpieces', WORKTREE_STATE_DIR, 'wt-feature'));
    });

    it('local() in the PRIMARY clone is unchanged — still <primary>/.webpieces, no namespace', () => {
        expect(dot.isLinkedWorktree(primary)).toBe(false);
        expect(dot.worktreeName(primary)).toBe('');
        expect(dot.local(primary)).toBe(path.join(primary, '.webpieces'));
    });

    it('shared() is the SAME path from the worktree and from the primary clone', () => {
        const expected = path.join(primary, '.webpieces');
        expect(dot.shared(worktree)).toBe(expected);
        expect(dot.shared(primary)).toBe(expected);
        // …and it is NOT under the worktree namespace: an atomic rename() into it must land on a real
        // directory in the primary clone, never on anything worktree-scoped.
        expect(dot.shared(worktree).includes(WORKTREE_STATE_DIR)).toBe(false);
    });

});

describe('DotWebpieces resolution edge cases', () => {
    beforeEach(() => { makeRepoWithWorktree('dotwp-edge-', 'wt-feature'); });
    afterEach(cleanupRepo);

    it('resolves identically from a SUBDIRECTORY of the worktree (the hook is often run from one)', () => {
        const subdir = path.join(worktree, 'packages', 'deep');
        fs.mkdirSync(subdir, { recursive: true });
        expect(dot.shared(subdir)).toBe(path.join(primary, '.webpieces'));
        expect(dot.local(subdir)).toBe(
            path.join(primary, '.webpieces', WORKTREE_STATE_DIR, 'wt-feature'));
    });

    it('two worktrees get DISJOINT local() dirs and the SAME shared() dir', () => {
        const second = path.join(tmp, 'wt-other');
        git(primary, `worktree add -q -b other ${second}`);
        expect(dot.local(worktree)).not.toBe(dot.local(second));
        expect(dot.shared(worktree)).toBe(dot.shared(second));
    });

    it('falls back to <dir>/.webpieces when the directory is not a git repo at all', () => {
        const notARepo = path.join(tmp, 'loose');
        fs.mkdirSync(notARepo);
        expect(dot.shared(notARepo)).toBe(path.join(notARepo, '.webpieces'));
        expect(dot.local(notARepo)).toBe(path.join(notARepo, '.webpieces'));
    });

});

describe('the config boundary', () => {
    beforeEach(() => { makeRepoWithWorktree('dotwp-config-', 'wt-feature'); });
    afterEach(cleanupRepo);

    /**
     * THE BOUNDARY. `webpieces.config.json` is TRACKED and therefore part of the BRANCH — a branch may
     * change its own rules. Only the gitignored `.webpieces/` STATE relocates. If this test ever fails,
     * a worktree has stopped being able to carry its own config and the change is wrong.
     */
    it('webpieces.config.json STILL resolves per-worktree — only .webpieces/ state moved', () => {
        writeFile(worktree, 'webpieces.config.json', '{"branchOwn": true}\n');
        expect(findConfigFile(worktree)).toBe(path.join(worktree, 'webpieces.config.json'));
        expect(new RepoRootFinder().resolveRepoRoot(worktree)).toBe(worktree);
        expect(JSON.parse(fs.readFileSync(path.join(worktree, 'webpieces.config.json'), 'utf8')))
            .toEqual({ branchOwn: true });
    });
});

/** The scope ASSIGNMENT — which files are repo-wide and which are the worktree's own. */
describe('scope assignment from inside a linked worktree', () => {
    beforeEach(() => {
        makeRepoWithWorktree('dotwp-scope-', 'wt-a');
    });

    afterEach(cleanupRepo);

    it('merged-branches.json is SHARED — the same file from the worktree and the primary clone', () => {
        const service = new MergedBranchesService(undefined, new DotWebpieces());
        const expected = path.join(primary, '.webpieces', 'merged-branches.json');
        expect(service.mergedBranchesPath(worktree)).toBe(expected);
        expect(service.mergedBranchesPath(primary)).toBe(expected);
    });

    it('main-sync status AND lock are SHARED — one refresher per repo, not per worktree', () => {
        const service = new MainSyncStatusService(new DotWebpieces());
        expect(service.mainSyncStatusPath(worktree))
            .toBe(path.join(primary, '.webpieces', 'main-sync-status.json'));
        expect(service.mainSyncLockPath(worktree))
            .toBe(path.join(primary, '.webpieces', 'main-sync.lock.json'));
        expect(service.mainSyncLockPath(worktree)).toBe(service.mainSyncLockPath(primary));
    });

    it('branch-mutations.log is LOCAL — one writer per worktree, and it survives the worktree', () => {
        const log = new BranchMutationLog(new DotWebpieces());
        const logPath = log.branchMutationLogPath(worktree);
        expect(logPath).toBe(path.join(
            primary, '.webpieces', WORKTREE_STATE_DIR, 'wt-a', 'hooks', 'branch-mutations.log'));
        expect(logPath).not.toBe(log.branchMutationLogPath(primary));

        const event = new BranchMutationEvent('wp-cleanup', 'REAP');
        event.fromBranch = 'feature';
        event.sha = 'abc1234';
        log.logBranchMutation(worktree, event);

        // The recovery record lives in the PRIMARY clone, so removing the worktree cannot destroy it —
        // which was the only real argument for making the log shared, and it is answered by the layout.
        git(primary, `worktree remove --force ${worktree}`);
        expect(fs.existsSync(worktree)).toBe(false);
        expect(fs.readFileSync(logPath, 'utf8')).toContain('recover=git branch feature abc1234');
    });
});
