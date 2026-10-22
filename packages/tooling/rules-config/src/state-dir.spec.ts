import { CheckoutLayout, specTempDirs } from '@webpieces/tooling-testkit';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

import { DotWebpieces, WORKTREE_STATE_DIR } from '@webpieces/tooling-common';
import { MergedBranchesService } from '@webpieces/repo-workflow-core';
import { MainSyncLockService, MainSyncStatusService } from '@webpieces/repo-workflow-core';
import { BranchMutationLog, BranchMutationEvent } from '@webpieces/repo-workflow-core';
import { RepoRootFinder } from './repo-root';
import { findConfigFile } from './config-file';


function writeFile(root: string, relPath: string, content: string): void {
    const full = path.join(root, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
}

/**
 * Linked worktrees laid out on disk EXACTLY as git lays them out (CheckoutLayout, #1381). The question
 * this resolver answers ("am I in a linked worktree, and where is the primary clone?") is answered from
 * those files — GitCheckout reads them and starts no process — so the layout IS the real input. That
 * the installed git writes this layout is proven once, against real git, by git-checkout.spec.ts and
 * worktree-identity.spec.ts.
 */
// Shared mutable fixture for the describes below. A fresh DotWebpieces per test on purpose: the
// resolver caches git's answer per start dir for the life of the process, which is right in production
// and wrong across throwaway repos inside one test file.
let tmp: string;
let primary: string;
let worktree: string;
let dot: DotWebpieces;

function makeRepoWithWorktree(prefix: string, worktreeDirName: string): void {
    // realpathSync: macOS os.tmpdir() is a symlink; the resolver returns the real path, so paths must be
    // compared against the resolved form.
    tmp = specTempDirs.makeReal(prefix);
    primary = path.join(tmp, 'primary');
    worktree = path.join(tmp, worktreeDirName);
    fs.mkdirSync(primary, { recursive: true });

    CheckoutLayout.primaryWithWorktree(primary, worktree, 'feature');
    writeFile(primary, 'webpieces.config.json', '{}\n');
    writeFile(primary, '.gitignore', '.webpieces/\n');

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
        expect(dot.gitDirs(worktree)?.isLinkedWorktree).toBe(true);
        expect(dot.worktreeName(worktree)).toBe('wt-feature');
        expect(dot.local(worktree)).toBe(
            path.join(primary, '.webpieces', WORKTREE_STATE_DIR, 'wt-feature'));
    });

    it('local() in the PRIMARY clone is unchanged — still <primary>/.webpieces, no namespace', () => {
        expect(dot.gitDirs(primary)?.isLinkedWorktree).toBe(false);
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
        CheckoutLayout.linkedWorktree(primary, second, 'other');
        expect(dot.local(worktree)).not.toBe(dot.local(second));
        expect(dot.shared(worktree)).toBe(dot.shared(second));
    });

    it('falls back to <dir>/.webpieces when the directory is not a git repo at all', () => {
        const notARepo = path.join(tmp, 'loose');
        fs.mkdirSync(notARepo);
        expect(dot.shared(notARepo)).toBe(path.join(notARepo, '.webpieces'));
        expect(dot.local(notARepo)).toBe(path.join(notARepo, '.webpieces'));
        expect(dot.aiWritable(notARepo)).toBe(path.join(notARepo, '.webpieces'));
    });

});

/**
 * aiWritable() exists for ONE constraint that no amount of path design can negotiate with: a
 * worktree-isolated coding agent's file-write tool refuses every path under the shared checkout. So the
 * state the flow ASKS AN AGENT TO WRITE (summary.json, and each reviewer subagent's review-<id>.json)
 * must resolve inside the worktree, while everything the TOOLING writes stays on local().
 */
describe('DotWebpieces.aiWritable() — the scope an isolated agent can actually write', () => {
    beforeEach(() => { makeRepoWithWorktree('dotwp-aiw-', 'wt-feature'); });
    afterEach(cleanupRepo);

    it('resolves INSIDE the linked worktree, never under the primary clone', () => {
        expect(dot.aiWritable(worktree)).toBe(path.join(worktree, '.webpieces'));
        // The whole point: not a subpath of the shared checkout's state dir.
        expect(dot.aiWritable(worktree).startsWith(dot.shared(worktree))).toBe(false);
        expect(dot.aiWritable(worktree)).not.toBe(dot.local(worktree));
    });

    it('is the SAME dir as local()/shared() in the primary clone — nothing changes without worktrees', () => {
        const expected = path.join(primary, '.webpieces');
        expect(dot.aiWritable(primary)).toBe(expected);
        expect(dot.local(primary)).toBe(expected);
        expect(dot.shared(primary)).toBe(expected);
    });

    it('resolves from a SUBDIRECTORY to the worktree ROOT, not to the subdirectory', () => {
        const subdir = path.join(worktree, 'packages', 'deep');
        fs.mkdirSync(subdir, { recursive: true });
        expect(dot.aiWritable(subdir)).toBe(path.join(worktree, '.webpieces'));
    });

    it('two worktrees get DISJOINT aiWritable() dirs — one review per tree, never shared', () => {
        const second = path.join(tmp, 'wt-other');
        CheckoutLayout.linkedWorktree(primary, second, 'other');
        expect(dot.aiWritable(worktree)).not.toBe(dot.aiWritable(second));
    });

    it('aiWritableFile() joins beneath it', () => {
        expect(dot.aiWritableFile(worktree, 'pr-review', 'feature'))
            .toBe(path.join(worktree, '.webpieces', 'pr-review', 'feature'));
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
        const locks = new MainSyncLockService(new DotWebpieces());
        expect(service.mainSyncStatusPath(worktree))
            .toBe(path.join(primary, '.webpieces', 'main-sync-status.json'));
        expect(locks.mainSyncLockPath(worktree))
            .toBe(path.join(primary, '.webpieces', 'main-sync.lock.json'));
        expect(locks.mainSyncLockPath(worktree)).toBe(locks.mainSyncLockPath(primary));
    });

    it('branch-mutations.log is LOCAL — one writer per worktree, and it survives the worktree', () => {
        const log = new BranchMutationLog(new DotWebpieces());
        const logPath = log.branchMutationLogPath(worktree);
        expect(logPath).toBe(path.join(
            primary, '.webpieces', WORKTREE_STATE_DIR, 'wt-a', 'logs', 'branch-mutations.log'));
        expect(logPath).not.toBe(log.branchMutationLogPath(primary));

        const event = new BranchMutationEvent('wp-cleanup', 'REAP');
        event.fromBranch = 'feature';
        event.sha = 'abc1234';
        log.logBranchMutation(worktree, event);

        // The recovery record lives in the PRIMARY clone, so removing the worktree cannot destroy it —
        // which was the only real argument for making the log shared, and it is answered by the layout.
        CheckoutLayout.removeLinkedWorktree(primary, worktree);
        expect(fs.existsSync(worktree)).toBe(false);
        expect(fs.readFileSync(logPath, 'utf8')).toContain('recover=git branch feature abc1234');
    });
});
