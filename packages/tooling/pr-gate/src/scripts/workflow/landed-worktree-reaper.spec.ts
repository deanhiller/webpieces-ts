import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The HAND-OFF is what is under test here: given "I just landed the branch this worktree holds", does
 * wp-land-pr spawn the reap in the PRIMARY CLONE — and does it keep the #512 manual notice, untouched,
 * in every case where it cannot?
 *
 * The reap itself is not re-tested here. WorktreeReaper owns the archive → remove → branch -D order,
 * the never-`--force` rule and the `recover=` line, and worktree-reaper.spec.ts proves all three
 * against a scripted git. What this spec proves is that the reap is invoked from a directory nobody
 * is deleting, which is the one property that spec cannot see.
 */
const world = vi.hoisted(() => ({
    porcelain: '',
    // Every non-git spawn, i.e. the child re-exec: argv plus the cwd it was given.
    spawns: [] as { argv: string[]; cwd: string }[],
    childStatus: 0,
    childStdout: '',
    childStderr: '',
}));

vi.mock('child_process', () => ({
    spawnSync: (
        cmd: string, args: string[], options: { cwd?: string },
    ): { status: number; stdout: string; stderr: string } => {
        if (cmd === 'git') {
            if (args[0] === 'worktree' && args[1] === 'list') {
                return { status: 0, stdout: world.porcelain, stderr: '' };
            }
            return { status: 0, stdout: '', stderr: '' };
        }
        world.spawns.push({ argv: [cmd, ...args], cwd: options.cwd ?? '' });
        return { status: world.childStatus, stdout: world.childStdout, stderr: world.childStderr };
    },
    execSync: (): string => '',
}));

import { WorktreeService } from '@webpieces/rules-config';

import { LandedWorktreeReaper, WorktreeReapHandoff } from './landed-worktree-reaper';

const PRIMARY = '/Users/dev/webpieces-ts';
const LINKED = '/Users/dev/webpieces-ts-feature';
const BRANCH = 'dean/fix-landreexec';
const ENTRY = '/pkg/src/scripts/wp-reap-worktree.js';

// Primary clone + one linked worktree holding the branch we are landing.
function porcelain(): string {
    return `worktree ${PRIMARY}\nHEAD aaa\nbranch refs/heads/main\n\n`
        + `worktree ${LINKED}\nHEAD bbb\nbranch refs/heads/${BRANCH}\n`;
}

// The entry point exists (the built case). `reapEntryScript` is a seam precisely because under vitest
// this package runs from .ts sources and the compiled sibling is genuinely not on disk.
class BuiltReaper extends LandedWorktreeReaper {
    protected reapEntryScript(): string {
        return ENTRY;
    }
}

// The unbuilt/unlocatable case: no entry point to spawn.
class UnbuiltReaper extends LandedWorktreeReaper {
    protected reapEntryScript(): string {
        return '';
    }
}

function built(): LandedWorktreeReaper {
    return new BuiltReaper(new WorktreeService());
}

beforeEach(() => {
    world.porcelain = porcelain();
    world.spawns = [];
    world.childStatus = 0;
    world.childStdout = '';
    world.childStderr = '';
});

describe('LandedWorktreeReaper — planning the hand-off', () => {
    /**
     * The whole point of the ticket: landing from a linked worktree must produce a reap that runs
     * SOMEWHERE ELSE. `cwd` on the spawn is the assertion — a child rooted in the primary clone is a
     * child that is not standing in the directory being removed.
     */
    it('re-execs the reap with cwd = the primary clone when the landed branch is held here', () => {
        const reaper = built();

        const handoff = reaper.plan(LINKED, BRANCH);

        expect(handoff).not.toBeNull();
        expect((handoff as WorktreeReapHandoff).canReap).toBe(true);
        expect((handoff as WorktreeReapHandoff).primaryPath).toBe(PRIMARY);
        expect((handoff as WorktreeReapHandoff).worktreePath).toBe(LINKED);

        reaper.handOff(handoff as WorktreeReapHandoff);

        expect(world.spawns.length).toBe(1);
        expect(world.spawns[0].cwd).toBe(PRIMARY);
        expect(world.spawns[0].argv).toEqual([process.execPath, ENTRY, LINKED, BRANCH]);
    });

    // Landing from the primary clone is the ordinary case and must not grow a special sentence — or a
    // child process. There is no worktree to remove, only a branch, which `pnpm wp-cleanup` handles.
    it('plans nothing when the landing happened in the primary clone', () => {
        expect(built().plan(PRIMARY, 'main')).toBeNull();
        expect(world.spawns.length).toBe(0);
    });

    // A worktree that holds some OTHER branch is not a corpse. Landing a branch from a directory that
    // does not hold it is a real (if odd) situation, and nothing about it authorises a removal.
    it('plans nothing when this worktree holds a different branch', () => {
        expect(built().plan(LINKED, 'dean/something-else')).toBeNull();
        expect(world.spawns.length).toBe(0);
    });

    /**
     * The honest-limitation path the ticket insists on. No entry point to re-exec ⇒ do NOT half-reap,
     * do NOT spawn anything, and print the #512 notice naming the exact directory to run cleanup from.
     */
    it('keeps the manual notice, and spawns nothing, when the reap entry point is missing', () => {
        const reaper = new UnbuiltReaper(new WorktreeService());

        const handoff = reaper.plan(LINKED, BRANCH) as WorktreeReapHandoff;

        expect(handoff.canReap).toBe(false);
        expect(handoff.blockedBecause).toContain('not on disk');
        expect(world.spawns.length).toBe(0);
        const notice = reaper.manualNotice(handoff);
        // Single-quoted (atRoot's format): a primary clone under a path with a space — "Google Drive",
        // "My Documents", `/Users/dean hiller/…` — makes a bare `cd` two arguments and it fails.
        expect(notice).toContain(`cd '${PRIMARY}' && pnpm wp-cleanup`);
        expect(notice).toContain(LINKED);
    });

    // Fail SAFE when git cannot place us in any worktree at all (an unavailable git, a bare repo, a
    // directory that is not a checkout): no tree identified means no tree removed, and no child.
    it('plans nothing when git cannot name the tree we are standing in', () => {
        world.porcelain = '';

        expect(built().plan(LINKED, BRANCH)).toBeNull();
        expect(world.spawns.length).toBe(0);
    });
});

describe('LandedWorktreeReaper — reporting what the child did', () => {
    // A successful reap deletes the directory the SHELL is sitting in. Saying so is not politeness:
    // every following relative path in that shell is an unexplained ENOENT until the human moves.
    it('tells the caller their cwd no longer exists after a successful reap', () => {
        world.childStdout = '  ✓ removed\n';
        const reaper = built();

        const out = reaper.handOff(reaper.plan(LINKED, BRANCH) as WorktreeReapHandoff);

        expect(out).toContain('NO LONGER EXISTS');
        expect(out).toContain(`cd '${PRIMARY}'`);   // quoted for the same reason as the manual notice
        expect(out).toContain('✓ removed');
    });

    /**
     * A child that failed — git refusing to remove a worktree with uncommitted or untracked files is
     * the expected reason — must report and fall back to the manual notice. Nothing is retried, and
     * `--force` appears nowhere: an untracked file is work no archive tag captured.
     */
    it('reports a failed reap and falls back to the manual notice, never forcing', () => {
        world.childStatus = 1;
        world.childStderr = "fatal: '/Users/dev/webpieces-ts-feature' contains modified or untracked files\n";
        const reaper = built();

        const out = reaper.handOff(reaper.plan(LINKED, BRANCH) as WorktreeReapHandoff);

        expect(out).toContain('contains modified or untracked files');
        expect(out).toContain('Nothing was forced');
        expect(out).toContain(`cd '${PRIMARY}' && pnpm wp-cleanup`);
        expect(out).not.toContain('--force');
    });

    // The primary clone is never the thing being removed — it is the thing being removed FROM. Nothing
    // in the argv the child is handed can name it.
    it('never hands the primary clone to the child as the removal target', () => {
        const reaper = built();

        reaper.handOff(reaper.plan(LINKED, BRANCH) as WorktreeReapHandoff);

        expect(world.spawns[0].argv).not.toContain(PRIMARY);
        expect(world.spawns[0].argv[2]).toBe(LINKED);
    });
});
