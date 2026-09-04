import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

import { ExcludePaths, MainSyncStatus, BranchStateGuardConfig, writeMainSyncStatus } from '@webpieces/rules-config';

import type { FileContext, Rule } from './types';

// The detached refresher must never spawn from a test. Everything ELSE here is real: real git, real
// worktrees, real `main-sync-status.json`. That is the point — issue #851 was invisible to every mock
// in this package precisely because the mocks stood in for the thing that was wrong (which tree git
// says a path belongs to), so a spec that mocked git could not have caught it and cannot guard it.
vi.mock('./main-sync-refresh', () => ({ triggerMainSyncRefresh: (): void => undefined }));

import { FeatureBranchGuardRule } from './rules/feature-branch-guard';
import { filterByExcludedPaths } from './excluded-paths';
import { GovernedPath, TargetTreeResolver } from './target-tree';

const PRIMARY_BRANCH = 'codex/primary-work';
const WORKTREE_BRANCH = 'dean/849-clean-branch';
const AGENT_ID = 'agent-851test';
const DETACHED_ID = 'agent-851detached';

let root = '';
let primary = '';
let worktree = '';
let detached = '';

function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

/**
 * A primary clone with linked worktrees checked out INSIDE it, at the exact path Claude Code uses:
 * `<primary>/.claude/worktrees/agent-<id>`. That placement IS the bug's trigger — a containment test
 * answers "primary" for everything under it — so the fixture reproduces it literally rather than
 * parking the worktrees somewhere convenient like a sibling directory.
 */
beforeAll((): void => {
    // REALPATH the fixture root. `os.tmpdir()` is `/var/folders/...` on macOS, which is a symlink to
    // `/private/var/folders/...`, and git answers in resolved paths — so an unresolved fixture root
    // compares unequal to every path the code under test produces, and the assertions would be about
    // macOS's `/var` symlink rather than about tree identity.
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wp-851-')));
    primary = path.join(root, 'primary');
    fs.mkdirSync(primary);

    git(primary, 'init', '--initial-branch=main');
    // A temp repo inherits the machine's global hooks, and this machine has a pre-push hook that
    // refuses commits to main. Point hooksPath at nothing so the fixture is hermetic.
    git(primary, 'config', 'core.hooksPath', '/dev/null');
    git(primary, 'config', 'user.email', 'test@example.com');
    git(primary, 'config', 'user.name', 'Test');
    fs.writeFileSync(path.join(primary, 'seed.txt'), 'seed\n');
    git(primary, 'add', '.');
    git(primary, 'commit', '-m', 'seed');

    git(primary, 'checkout', '-b', PRIMARY_BRANCH);

    worktree = path.join(primary, '.claude', 'worktrees', AGENT_ID);
    git(primary, 'worktree', 'add', '-b', WORKTREE_BRANCH, worktree, 'main');
    fs.mkdirSync(path.join(worktree, 'src'), { recursive: true });
    fs.writeFileSync(path.join(worktree, 'src', 'a.ts'), 'export const a = 1;\n');

    // A SECOND worktree, permanently on a detached HEAD. A separate tree rather than detaching and
    // re-attaching the first one: a fixture that has to be put back is a fixture that leaks into the
    // next test the day somebody adds an early return.
    detached = path.join(primary, '.claude', 'worktrees', DETACHED_ID);
    git(primary, 'worktree', 'add', '--detach', detached, 'main');
    fs.mkdirSync(path.join(detached, 'src'), { recursive: true });
    fs.writeFileSync(path.join(detached, 'src', 'a.ts'), 'export const a = 1;\n');
});

afterAll((): void => {
    fs.rmSync(root, { recursive: true, force: true });
});

function status(branch: string, conflict: boolean, conflictFiles: string[] = []): MainSyncStatus {
    return new MainSyncStatus(
        branch, false, '', true, 'fork-sha', 'origin-sha', 'head-sha', conflict, conflictFiles,
        new Date().toISOString(),
    );
}

// The measured shape from issue #851: the branch-keyed cache holds BOTH branches, the primary's in
// conflict and the worktree's clean. The right answer was always in this file; only the key was wrong.
function seedCache(): void {
    writeMainSyncStatus(primary, status(PRIMARY_BRANCH, true, ['pnpm-lock.yaml', 'pnpm-workspace.yaml']));
    writeMainSyncStatus(primary, status(WORKTREE_BRANCH, false));
}

// A main-session Edit: the SESSION (and therefore `workspaceRoot`, the walk-up to the governing
// config) is the primary clone, while the file being written lives in a worktree.
function editIn(tree: string, relative: string = 'src/a.ts'): FileContext {
    const filePath = path.join(tree, relative);
    return {
        tool: 'Edit',
        filePath,
        relativePath: path.relative(primary, filePath),
        workspaceRoot: primary,
        options: {},
    } as FileContext;
}

function rule(): FeatureBranchGuardRule {
    const cfg = new BranchStateGuardConfig();
    cfg.mode = 'ON';
    return new FeatureBranchGuardRule(cfg);
}

describe('TargetTreeResolver — git decides which tree owns a FILE', () => {
    it('resolves a path inside a worktree nested in the primary clone to the WORKTREE', () => {
        const tree = new TargetTreeResolver().resolve(path.join(worktree, 'src', 'a.ts'), primary);
        expect(tree.kind).toBe('worktree');
        expect(fs.realpathSync(tree.root)).toBe(fs.realpathSync(worktree));
    });

    it('resolves a path in the primary clone to the PRIMARY clone', () => {
        const tree = new TargetTreeResolver().resolve(path.join(primary, 'seed.txt'), primary);
        expect(tree.kind).toBe('primary');
        expect(fs.realpathSync(tree.root)).toBe(fs.realpathSync(primary));
    });

    /*
     * A Write legitimately names a file — and directories — that do not exist yet, and git cannot be
     * asked about a directory that is not there. The walk-up to the nearest existing ancestor is what
     * keeps a brand-new file in a brand-new directory classified as its worktree's rather than falling
     * back to the governed root, which would silently restore the whole defect for every `Write`.
     */
    it('classifies a file that does not exist yet, in directories that do not exist yet', () => {
        const unborn = path.join(worktree, 'brand', 'new', 'dir', 'file.ts');
        const tree = new TargetTreeResolver().resolve(unborn, primary);
        expect(tree.kind).toBe('worktree');
        expect(fs.realpathSync(tree.root)).toBe(fs.realpathSync(worktree));
    });

    it('gives GovernedPath two DIFFERENT spellings in a worktree and one in the primary clone', () => {
        const resolver = new TargetTreeResolver();
        const inWorktree = resolver.governedPath(path.join(worktree, 'src', 'a.ts'), primary);
        expect(inWorktree.relativePath).toBe(path.join('.claude', 'worktrees', AGENT_ID, 'src', 'a.ts'));
        expect(inWorktree.treeRelativePath).toBe(path.join('src', 'a.ts'));

        const inPrimary = resolver.governedPath(path.join(primary, 'seed.txt'), primary);
        expect(inPrimary.relativePath).toBe('seed.txt');
        expect(inPrimary.treeRelativePath).toBe('seed.txt');
    });
});

/*
 * THE REGRESSION TEST FOR #851. Before the fix the first case BLOCKS: the guard resolved the tree from
 * `workspaceRoot` (the primary clone), read the cache under the PRIMARY's branch, found
 * `conflict: true`, and refused an edit to a file on a clean branch in another checkout — citing
 * `pnpm-lock.yaml` and `pnpm-workspace.yaml`, which that branch had never touched.
 */
describe('feature-branch-guard judges the tree that owns the FILE (issue #851)', () => {
    it('ALLOWS an edit in a CLEAN worktree while the primary clone conflicts with main', () => {
        seedCache();
        expect(rule().check(editIn(worktree))).toEqual([]);
    });

    it('still BLOCKS when the WORKTREE\'S OWN branch conflicts — the fix narrows nothing', () => {
        writeMainSyncStatus(primary, status(PRIMARY_BRANCH, false));
        writeMainSyncStatus(primary, status(WORKTREE_BRANCH, true, ['src/a.ts']));

        const violations = rule().check(editIn(worktree));
        expect(violations).toHaveLength(1);
        expect(violations[0].message).toContain('src/a.ts');
    });

    // A wrong resolution has to be VISIBLE. With neither branch nor tree in the text there was nothing
    // to contradict, which is how the misfire survived four tool calls looking like an ordinary block.
    it('names the BRANCH and the TREE it judged, and aims the cure at that tree', () => {
        writeMainSyncStatus(primary, status(WORKTREE_BRANCH, true, ['src/a.ts']));

        const message = rule().check(editIn(worktree))[0].message ?? '';
        expect(message).toContain(WORKTREE_BRANCH);
        expect(message).toContain(worktree);
        // The cure is `pnpm --dir=<judged tree> …`, because `wp-start-update` acts on the tree it runs
        // in and the judged tree is not the session's. Printed unqualified it is a measured no-op.
        expect(message).toContain(`pnpm --dir='${worktree}' wp-start-update`);
    });

    /*
     * DETACHED HEAD in the TARGET tree — matrix row 14. There is no branch name, so there is no key
     * into the branch-keyed cache and nothing to judge. Fail open: this used to arrive as the literal
     * branch `HEAD`, miss in the cache, and be logged as `no-sync-cache` — the right verdict filed
     * under the wrong cause. The primary is left CONFLICTING so a pass cannot come from the cache
     * simply being clean everywhere.
     */
    it('fails OPEN when the target tree is on a detached HEAD', () => {
        writeMainSyncStatus(primary, status(PRIMARY_BRANCH, true, ['pnpm-lock.yaml']));
        expect(rule().check(editIn(detached))).toEqual([]);
    });
});

/*
 * The `.webpieces/` exemption, in the spelling that was NOT exempt.
 *
 * `<primary>/.webpieces/worktrees/agent-X/pr-review/…/review-1.json` was exempt; the same kind of file
 * at `<primary>/.claude/worktrees/agent-X/.webpieces/pr-review/…/review.json` was not, because the skip
 * was asked about the GOVERNED-root spelling, where that path begins `.claude`. This matters out of all
 * proportion to its size: `wp-review-upsert-pr` REQUIRES that file before `wp-finish-upsert-pr` will
 * open a PR, so the guard could forbid a file the gate demands.
 */
describe('the .webpieces/ state-dir exemption follows the tree that owns the file', () => {
    const rules: readonly Rule[] = [{ name: 'feature-branch-guard', configKey: 'branch-state-guard' } as unknown as Rule];

    function governed(absolute: string): GovernedPath {
        return new TargetTreeResolver().governedPath(absolute, primary);
    }

    function reviewJson(): string {
        return path.join(worktree, '.webpieces', 'pr-review', WORKTREE_BRANCH, 'review.json');
    }

    // The PRE-FIX behaviour, asserted so the change is a measured one rather than a claimed one: the
    // governed-root spelling of this path does NOT match the predicate, and never did.
    it('is NOT exempt when the path is judged by its governed-root spelling', () => {
        const review = reviewJson();
        const asGovernedRootRelative = new GovernedPath(path.relative(primary, review), path.relative(primary, review));
        expect(filterByExcludedPaths(rules, asGovernedRootRelative, new ExcludePaths([]))).toEqual(rules);
    });

    it('IS exempt once the path is judged by the tree that owns it', () => {
        expect(filterByExcludedPaths(rules, governed(reviewJson()), new ExcludePaths([]))).toEqual([]);
    });

    it('keeps the primary clone\'s own state dir exempt (unchanged)', () => {
        const verdict = path.join(primary, '.webpieces', 'worktrees', AGENT_ID, 'pr-review', 'b', 'review-1.json');
        expect(filterByExcludedPaths(rules, governed(verdict), new ExcludePaths([]))).toEqual([]);
    });

    // FIRST SEGMENT OF THE OWNING TREE, still — not "anything containing .webpieces". A nested
    // `.webpieces` belonging to a package inside the worktree stays governed, exactly as it does in the
    // primary clone.
    it('does NOT exempt a nested .webpieces owned by something else inside the worktree', () => {
        const nested = path.join(worktree, 'packages', '.webpieces', 'x.ts');
        expect(filterByExcludedPaths(rules, governed(nested), new ExcludePaths([]))).toEqual(rules);
    });
});
