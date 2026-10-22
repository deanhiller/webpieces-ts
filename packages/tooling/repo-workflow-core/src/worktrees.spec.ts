import * as fs from 'fs';
import * as path from 'path';
import { afterEach, describe, it, expect, beforeEach } from 'vitest';
import { ProcessCallDto, specTempDirs } from '@webpieces/tooling-testkit';

import { WorkflowFeature } from './__tests__/workflow-feature';
import { CommandTimeouts } from './command-timeouts';
import { WorktreeService, Worktree } from './worktrees';

const WORKTREE_LIST = ['worktree', 'list', '--porcelain'];

let feature: WorkflowFeature;
let worktrees: WorktreeService;
const dirs: string[] = [];

beforeEach(async () => {
    feature = await WorkflowFeature.create();
    worktrees = feature.container.get(WorktreeService);
});

afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

// A checkout root whose `.git` is a directory (primary clone), a file (linked worktree), or absent.
function checkout(dotGit: 'dir' | 'file' | 'missing'): string {
    const root = specTempDirs.make('wp-worktrees-');
    dirs.push(root);
    if (dotGit === 'dir') fs.mkdirSync(path.join(root, '.git'));
    if (dotGit === 'file') fs.writeFileSync(path.join(root, '.git'), 'gitdir: /repo/.git/worktrees/feature\n');
    return root;
}

function porcelain(lines: string[]): void {
    feature.git.respond(WORKTREE_LIST, feature.git.ok(lines.join('\n')));
}

describe('WorktreeService.isLinkedWorktree', () => {
    it('is false in the primary clone (.git is a DIRECTORY)', () => {
        expect(worktrees.isLinkedWorktree(checkout('dir'))).toBe(false);
        expect(feature.git.calls).toEqual([]);
    });

    it('is true in a linked worktree (.git is a FILE holding a gitdir: pointer)', () => {
        expect(worktrees.isLinkedWorktree(checkout('file'))).toBe(true);
    });

    // Fail-open: an unreadable/absent .git must NOT be reported as a worktree, because callers print
    // the worktree-only command when this says true. Unknown → both forms → recoverable.
    it('is false when .git cannot be read at all', () => {
        expect(worktrees.isLinkedWorktree(checkout('missing'))).toBe(false);
    });
});

describe('WorktreeService', () => {
    it('parses the porcelain records, marking the FIRST as the primary clone', () => {
        porcelain([
            'worktree /repo',
            'HEAD aaa',
            'branch refs/heads/main',
            '',
            'worktree /work/feature',
            'HEAD bbb',
            'branch refs/heads/dean/feature',
            '',
        ]);

        const trees = worktrees.listWorktrees('/repo');

        expect(trees.length).toBe(2);
        expect(trees[0].isMain).toBe(true);
        expect(trees[0].branch).toBe('main');
        expect(trees[1].isMain).toBe(false);
        expect(trees[1].path).toBe('/work/feature');
        // refs/heads/ is stripped — `git branch -D` takes the short name.
        expect(trees[1].branch).toBe('dean/feature');
        // The guard's blocking path: ONE synchronous call, bounded by the local-git ceiling.
        const issued = feature.git.calls.map((call: ProcessCallDto): string =>
            `${call.commandLine} @${call.cwd ?? ''} ${call.mode} ${String(call.timeoutMs)}`);
        expect(issued).toEqual([`git worktree list --porcelain @/repo runSync ${String(CommandTimeouts.LOCAL_GIT_MS)}`]);
    });

    /**
     * The `HEAD <sha>` line was already on the wire and the parser dropped it, which left a branch NAME
     * as the only way to identify a tree. It is not one: a second clone or a stale worktree holds the
     * same name at a different commit, and `wp-land-pr` needs the pair to pick the tree whose HEAD is
     * the exact commit GitHub squashed. Reading it costs nothing — no extra git call.
     */
    it('carries each record\'s HEAD sha, which a branch name alone cannot identify', () => {
        porcelain([
            'worktree /repo',
            'HEAD aaa',
            'branch refs/heads/main',
            '',
            'worktree /work/feature',
            'HEAD bbb',
            'branch refs/heads/dean/feature',
            '',
            'worktree /work/detached',
            'HEAD ccc',
            'detached',
            '',
        ]);

        const trees = worktrees.listWorktrees('/repo');

        expect(trees.map((tree: Worktree): string => tree.head)).toEqual(['aaa', 'bbb', 'ccc']);
        // A detached worktree still has a HEAD — it is only the BRANCH that is missing.
        expect(trees[2].branch).toBe('');
        expect(feature.git.calls).toHaveLength(1);
    });

    it('reads detached, prunable and locked records', () => {
        porcelain([
            'worktree /repo',
            'HEAD aaa',
            'branch refs/heads/main',
            '',
            'worktree /work/detached',
            'HEAD bbb',
            'detached',
            '',
            'worktree /work/gone',
            'HEAD ccc',
            'branch refs/heads/dean/gone',
            'prunable gitdir file points to non-existent location',
            '',
            'worktree /work/held',
            'HEAD ddd',
            'branch refs/heads/dean/held',
            'locked reason why',
            '',
        ]);

        const trees = worktrees.listWorktrees('/repo');

        expect(trees.length).toBe(4);
        // Detached: no branch to reap, so a human must decide.
        expect(trees[1].branch).toBe('');
        expect(trees[2].prunable).toBe(true);
        expect(trees[3].locked).toBe(true);
    });

    // Fail SOFT: a git that errors must read as "no worktrees" so the caller's cap fails OPEN.
    it('returns [] when git fails', () => {
        feature.git.respond(WORKTREE_LIST, feature.git.fail(1, 'fatal: not a git repository'));
        expect(worktrees.listWorktrees('/repo').length).toBe(0);
    });
});

describe('WorktreeService budgets', () => {
    it('excludes the primary clone from linkedWorktrees — it is not removable, so it must not spend the budget', () => {
        porcelain([
            'worktree /repo',
            'HEAD aaa',
            'branch refs/heads/main',
            '',
            'worktree /work/one',
            'HEAD bbb',
            'branch refs/heads/one',
            '',
        ]);

        const linked = worktrees.linkedWorktrees('/repo');
        expect(linked.map((tree: Worktree): string => tree.path)).toEqual(['/work/one']);
    });

    // heldBranches drives BOTH the parked-branch count and the reap-safety spare, so it must include
    // the primary clone's own branch: git refuses to delete that one too.
    it('heldBranches includes the primary clone branch and skips detached worktrees', () => {
        porcelain([
            'worktree /repo',
            'HEAD aaa',
            'branch refs/heads/main',
            '',
            'worktree /work/one',
            'HEAD bbb',
            'branch refs/heads/dean/one',
            '',
            'worktree /work/detached',
            'HEAD ccc',
            'detached',
            '',
        ]);

        const held = worktrees.heldBranches('/repo');
        expect([...held].sort()).toEqual(['dean/one', 'main']);
    });
});
