import { describe, it, expect, vi, beforeEach } from 'vitest';

const git = vi.hoisted(() => ({
    porcelain: '' as string,
    status: 0,
    // What `<root>/.git` is: a directory (primary clone), a file (linked worktree), or absent.
    dotGit: 'dir' as 'dir' | 'file' | 'missing',
}));

vi.mock('child_process', () => ({
    spawnSync: (): { status: number; stdout: string } => ({ status: git.status, stdout: git.porcelain }),
}));

vi.mock('fs', () => ({
    statSync: (): { isDirectory: () => boolean } => {
        if (git.dotGit === 'missing') throw new Error('ENOENT: no such file or directory');
        return { isDirectory: (): boolean => git.dotGit === 'dir' };
    },
}));

import { WorktreeService, Worktree } from './worktrees';

beforeEach(() => {
    git.status = 0;
    git.porcelain = '';
    git.dotGit = 'dir';
});

describe('WorktreeService.isLinkedWorktree', () => {
    it('is false in the primary clone (.git is a DIRECTORY)', () => {
        git.dotGit = 'dir';
        expect(new WorktreeService().isLinkedWorktree('/repo')).toBe(false);
    });

    it('is true in a linked worktree (.git is a FILE holding a gitdir: pointer)', () => {
        git.dotGit = 'file';
        expect(new WorktreeService().isLinkedWorktree('/work/feature')).toBe(true);
    });

    // Fail-open: an unreadable/absent .git must NOT be reported as a worktree, because callers print
    // the worktree-only command when this says true. Unknown → both forms → recoverable.
    it('is false when .git cannot be read at all', () => {
        git.dotGit = 'missing';
        expect(new WorktreeService().isLinkedWorktree('/not/a/repo')).toBe(false);
    });
});

describe('WorktreeService.currentWorktree', () => {
    const PORCELAIN = [
        'worktree /repo',
        'HEAD aaa',
        'branch refs/heads/main',
        '',
        'worktree /work/feature',
        'HEAD bbb',
        'branch refs/heads/dean/feature',
        '',
    ].join('\n');

    it('finds the record whose path is the tree we are standing in', () => {
        git.porcelain = PORCELAIN;
        const tree = new WorktreeService().currentWorktree('/work/feature');
        expect(tree?.branch).toBe('dean/feature');
        expect(tree?.isMain).toBe(false);
    });

    it('matches the primary clone too, and normalizes a trailing slash', () => {
        git.porcelain = PORCELAIN;
        expect(new WorktreeService().currentWorktree('/repo/')?.isMain).toBe(true);
    });

    it('returns null when the root is not one of git\'s worktrees', () => {
        git.porcelain = PORCELAIN;
        expect(new WorktreeService().currentWorktree('/somewhere/else')).toBeNull();
    });
});

describe('WorktreeService', () => {
    it('parses the porcelain records, marking the FIRST as the primary clone', () => {
        git.porcelain = [
            'worktree /repo',
            'HEAD aaa',
            'branch refs/heads/main',
            '',
            'worktree /work/feature',
            'HEAD bbb',
            'branch refs/heads/dean/feature',
            '',
        ].join('\n');

        const trees = new WorktreeService().listWorktrees('/repo');

        expect(trees.length).toBe(2);
        expect(trees[0].isMain).toBe(true);
        expect(trees[0].branch).toBe('main');
        expect(trees[1].isMain).toBe(false);
        expect(trees[1].path).toBe('/work/feature');
        // refs/heads/ is stripped — `git branch -D` takes the short name.
        expect(trees[1].branch).toBe('dean/feature');
    });

    it('reads detached, prunable and locked records', () => {
        git.porcelain = [
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
        ].join('\n');

        const trees = new WorktreeService().listWorktrees('/repo');

        expect(trees.length).toBe(4);
        // Detached: no branch to reap, so a human must decide.
        expect(trees[1].branch).toBe('');
        expect(trees[2].prunable).toBe(true);
        expect(trees[3].locked).toBe(true);
    });

    // Fail SOFT: a git that errors must read as "no worktrees" so the caller's cap fails OPEN.
    it('returns [] when git fails', () => {
        git.status = 1;
        expect(new WorktreeService().listWorktrees('/repo').length).toBe(0);
    });
});

describe('WorktreeService budgets', () => {
    it('excludes the primary clone from linkedWorktrees — it is not removable, so it must not spend the budget', () => {
        git.porcelain = [
            'worktree /repo',
            'HEAD aaa',
            'branch refs/heads/main',
            '',
            'worktree /work/one',
            'HEAD bbb',
            'branch refs/heads/one',
            '',
        ].join('\n');

        const linked = new WorktreeService().linkedWorktrees('/repo');
        expect(linked.map((tree: Worktree): string => tree.path)).toEqual(['/work/one']);
    });

    // heldBranches drives BOTH the parked-branch count and the reap-safety spare, so it must include
    // the primary clone's own branch: git refuses to delete that one too.
    it('heldBranches includes the primary clone branch and skips detached worktrees', () => {
        git.porcelain = [
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
        ].join('\n');

        const held = new WorktreeService().heldBranches('/repo');
        expect([...held].sort()).toEqual(['dean/one', 'main']);
    });
});
