import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * A fake git world, in the same shape branch-reaper.spec.ts uses. `calls` is the assertion surface that
 * matters most: it records EVERY git invocation in order, which is how the archive → worktree remove →
 * branch -D ORDER is proven rather than asserted about individually.
 */
const world = vi.hoisted(() => ({
    // `git worktree list --porcelain` output.
    porcelain: '',
    // Paths whose `git worktree remove` fails, mapped to git's stderr (the untracked-files refusal).
    removeFails: {} as Record<string, string>,
    // Tag names whose `git tag` fails, mapped to git's stderr.
    tagFails: {} as Record<string, string>,
    // Every git invocation, as `argv.join(' ')`, in order.
    calls: [] as string[],
    logLines: [] as string[],
}));

vi.mock('child_process', () => ({
    spawnSync: (cmd: string, args: string[]): { status: number; stdout: string; stderr: string } => {
        if (cmd !== 'git') return { status: 1, stdout: '', stderr: '' };
        world.calls.push(args.join(' '));

        if (args[0] === 'worktree' && args[1] === 'list') {
            return { status: 0, stdout: world.porcelain, stderr: '' };
        }
        if (args[0] === 'worktree' && args[1] === 'remove') {
            const failure = world.removeFails[String(args[2])];
            if (failure !== undefined) return { status: 1, stdout: '', stderr: failure };
            return { status: 0, stdout: '', stderr: '' };
        }
        if (args[0] === 'rev-parse') {
            // The archiver's tag-collision probe — no tag pre-exists in this world.
            if (args[1] === '--verify') return { status: 1, stdout: '', stderr: '' };
            return { status: 0, stdout: `sha-${String(args[1])}`, stderr: '' };
        }
        if (args[0] === 'tag') {
            const failure = world.tagFails[String(args[1])];
            if (failure !== undefined) return { status: 1, stdout: '', stderr: failure };
            return { status: 0, stdout: '', stderr: '' };
        }
        return { status: 0, stdout: '', stderr: '' };
    },
}));

vi.mock('fs', () => ({
    mkdirSync: (): void => undefined,
    statSync: (): never => { throw new Error('no log file yet'); },
    existsSync: (): boolean => false,
    appendFileSync: (_p: string, line: string): void => { world.logLines.push(line); },
    writeFileSync: (): void => undefined,
    readFileSync: (): string => '{}',
}));

import { BRANCH_RETENTION_DELETE, BRANCH_RETENTION_KEEP } from './branch-archiver';
import {
    CLASSIFICATION_MERGED_PR,
    CLASSIFICATION_PRUNABLE,
    DeletableWorktree,
} from './merged-branches';
import { ReapedWorktree, WorktreeReaper } from './worktree-reaper';

const MAIN = '/repo';
const LINKED = '/work/wt-dead';

// Primary clone + one linked worktree, as `git worktree list --porcelain` renders them.
function porcelain(): string {
    return `worktree ${MAIN}\nHEAD aaa\nbranch refs/heads/main\n\n`
        + `worktree ${LINKED}\nHEAD bbb\nbranch refs/heads/dean/merged\n`;
}

function dead(treePath: string = LINKED, branch: string = 'dean/merged'): DeletableWorktree {
    return new DeletableWorktree(
        treePath, branch, 'PR #430 merged', 430, true, CLASSIFICATION_MERGED_PR);
}

const reaper = new WorktreeReaper();

beforeEach(() => {
    world.porcelain = porcelain();
    world.removeFails = {};
    world.tagFails = {};
    world.calls = [];
    world.logLines = [];
});

describe('WorktreeReaper — the order is the whole contract', () => {
    /**
     * archive → `git worktree remove` → `git branch -D`, in that order and no other:
     *  - archive FIRST, so nothing is destroyed before a permanent ref points at the branch tip;
     *  - remove BEFORE the branch delete, because git refuses to delete a branch a worktree holds.
     */
    it('archives, then removes the worktree, then deletes the branch', () => {
        const result = reaper.reapWorktrees(MAIN, MAIN, 'wp-cleanup', [dead()]);

        const ordered = world.calls.filter((call: string): boolean =>
            call.startsWith('tag ') || call.startsWith('worktree remove') || call.startsWith('branch -D'));
        expect(ordered.length).toBe(3);
        expect(ordered[0]).toMatch(/^tag archive\/\d{4}-\d{2}-\d{2}\/dean\/merged /);
        expect(ordered[1]).toBe(`worktree remove ${LINKED}`);
        expect(ordered[2]).toBe('branch -D dean/merged');

        expect(result.reaped.length).toBe(1);
        expect(result.reaped[0].branchDeleted).toBe(true);
        expect(result.reaped[0].archiveTag).toContain('dean/merged');
    });

    // The removal is never forced, in any code path. `--force` would delete untracked files that no
    // archive tag captured, which turns a cleanup command into a data-loss command.
    it('never passes --force to git worktree remove', () => {
        world.removeFails = { [LINKED]: "fatal: '/work/wt-dead' contains modified or untracked files" };

        reaper.reapWorktrees(MAIN, MAIN, 'wp-cleanup', [dead()]);

        expect(world.calls.join('\n')).not.toContain('--force');
        expect(world.calls.join('\n')).not.toContain(' -f');
    });

    // A worktree git refuses to remove is REPORTED, not retried and not silently skipped — and its
    // branch is left alone, since it is still checked out there.
    it('reports a worktree with uncommitted changes as a clean failure', () => {
        world.removeFails = { [LINKED]: "fatal: '/work/wt-dead' contains modified or untracked files" };

        const result = reaper.reapWorktrees(MAIN, MAIN, 'wp-cleanup', [dead()]);

        expect(result.reaped.length).toBe(0);
        expect(result.failed.length).toBe(1);
        expect(result.failed[0].error).toContain('contains modified or untracked files');
        expect(result.failed[0].error).toContain('not forced');
        expect(world.calls).not.toContain('branch -D dean/merged');
    });

    // Same rule BranchArchiver already enforces for branches: no archive, no delete. Here it also means
    // no directory is removed — the fail-safe direction is a worktree that survives one more cycle.
    it('removes nothing when the branch could not be archived', () => {
        world.tagFails = { [`archive/${today()}/dean/merged`]: 'fatal: tag already exists' };

        const result = reaper.reapWorktrees(MAIN, MAIN, 'wp-cleanup', [dead()]);

        expect(world.calls.join('\n')).not.toContain('worktree remove');
        expect(result.failed[0].error).toContain('could not archive its branch first');
    });

    // A prunable worktree's directory is already gone, so `git worktree remove` FAILS on it — the reap
    // is `git worktree prune`. This is why the verdict carries a classification token at all.
    it('prunes rather than removes a worktree whose directory is already gone', () => {
        const gone = new DeletableWorktree(
            '/work/wt-gone', 'dean/gone', 'its directory is gone', 0, true, CLASSIFICATION_PRUNABLE);

        reaper.reapWorktrees(MAIN, MAIN, 'wp-cleanup', [gone]);

        expect(world.calls).toContain('worktree prune');
        expect(world.calls.join('\n')).not.toContain('worktree remove');
    });
});

describe('WorktreeReaper safety rails — the two directories that are never removable', () => {
    /**
     * Removing your own cwd mid-command deletes the files underneath the running process, including the
     * checkout an agent's next tool call will try to read. The rail is INDEPENDENT of the verdict,
     * because reapWorktrees takes a caller-supplied list and a human's "all" must not be able to reach it.
     */
    it('refuses to remove the worktree it is running in', () => {
        const result = reaper.reapWorktrees(MAIN, LINKED, 'wp-cleanup', [dead()]);

        expect(world.calls.join('\n')).not.toContain('worktree remove');
        expect(result.reaped.length).toBe(0);
        expect(result.spared[0].reason).toContain('self-destruct');
    });

    // Running from a SUBDIRECTORY of the worktree is the same situation — the containing tree is what
    // matters, not the exact directory.
    it('refuses when cwd is merely inside that worktree', () => {
        const result = reaper.reapWorktrees(MAIN, `${LINKED}/packages/tooling`, 'wp-cleanup', [dead()]);

        expect(world.calls.join('\n')).not.toContain('worktree remove');
        expect(result.spared.length).toBe(1);
    });

    // The primary clone owns .git. git could not remove it anyway, and a caller that got it into a
    // target list has a bug we must not execute on their behalf.
    it('refuses to remove the primary clone', () => {
        const result = reaper.reapWorktrees(MAIN, '/somewhere/else', 'wp-cleanup', [dead(MAIN, 'main')]);

        expect(world.calls.join('\n')).not.toContain('worktree remove');
        expect(result.spared[0].reason).toContain('primary clone');
        expect(result.spared[0].reason).not.toContain('self-destruct');
    });

    // 'keep' turns the reap into a pure report — nothing tagged, nothing removed, everything visible.
    it('removes nothing at all under retention "keep"', () => {
        const result = reaper.reapWorktrees(MAIN, MAIN, 'wp-cleanup', [dead()], BRANCH_RETENTION_KEEP);

        expect(world.calls.join('\n')).not.toContain('worktree remove');
        expect(result.spared.length).toBe(1);
    });
});

describe('WorktreeReaper audit trail', () => {
    /**
     * Restoring a reaped worktree is `git worktree add -b <branch> <path> <ref>` — verified by hand
     * against real git. Plain `git worktree add <path> <tag>` restores the files at a DETACHED HEAD,
     * silently losing the branch name, so a recover line in that form would restore half of what was
     * destroyed while reading as complete.
     */
    it('logs the removal with a recover command that restores BOTH the directory and the branch', () => {
        const result = reaper.reapWorktrees(MAIN, MAIN, 'wp-cleanup', [dead()]);

        const line = world.logLines.join('');
        expect(line).toContain('REAP_WORKTREE');
        expect(line).toContain(`worktree=${LINKED}`);
        expect(line).toMatch(
            new RegExp(`recover=git worktree add -b dean/merged ${LINKED} archive/\\d{4}-\\d{2}-\\d{2}/dean/merged`));
        expect(reaper.restoreCommand(result.reaped[0]))
            .toContain(`git worktree add -b dean/merged ${LINKED} archive/`);
    });

    // With retention 'delete' there is no tag, so the recover ref falls back to the pre-removal sha.
    it('falls back to the sha when nothing was archived', () => {
        const result: ReapedWorktree = reaper.reapWorktrees(
            MAIN, MAIN, 'wp-cleanup', [dead()], BRANCH_RETENTION_DELETE).reaped[0];

        expect(result.archiveTag).toBe('');
        expect(world.logLines.join('')).toContain(
            `recover=git worktree add -b dean/merged ${LINKED} sha-dean/merged`);
    });
});

function today(): string {
    const now = new Date();
    const pad = (value: number): string => String(value).padStart(2, '0');
    return `${String(now.getFullYear())}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
