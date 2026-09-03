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

import { Worktree, WorktreeService } from '@webpieces/rules-config';

import { LandedWorktreeReaper, WorktreeReapHandoff } from './landed-worktree-reaper';
import { ReapOutcomeSignal, REAP_OUTCOME_REFUSED, REAP_OUTCOME_REMOVED } from './reap-outcome';

const PRIMARY = '/Users/dev/webpieces-ts';
const LINKED = '/Users/dev/webpieces-ts-feature';
const BRANCH = 'dean/fix-landreexec';
const LINKED_HEAD = 'bbb';
const ENTRY = '/pkg/src/scripts/wp-reap-worktree.js';

// Primary clone + one linked worktree holding the branch we are landing.
function porcelain(): string {
    return `worktree ${PRIMARY}\nHEAD aaa\nbranch refs/heads/main\n\n`
        + `worktree ${LINKED}\nHEAD ${LINKED_HEAD}\nbranch refs/heads/${BRANCH}\n`;
}

/**
 * The tree LandedTreeResolver picked: it holds the landed branch AT the commit GitHub squashed. `plan`
 * is TOLD this rather than deriving it from a cwd — see the class doc for why the cwd answer was wrong
 * both mechanically (pnpm's hoist) and in principle (a coordinator is standing somewhere else).
 */
function landedTree(): Worktree {
    return new Worktree(LINKED, BRANCH, LINKED_HEAD, false, false, false, '');
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
    return new BuiltReaper(new WorktreeService(), new ReapOutcomeSignal());
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

        const handoff = reaper.plan(LINKED, landedTree(), LINKED);

        expect(handoff).not.toBeNull();
        expect((handoff as WorktreeReapHandoff).canReap).toBe(true);
        expect((handoff as WorktreeReapHandoff).primaryPath).toBe(PRIMARY);
        expect((handoff as WorktreeReapHandoff).worktreePath).toBe(LINKED);

        reaper.handOff(handoff as WorktreeReapHandoff);

        expect(world.spawns.length).toBe(1);
        expect(world.spawns[0].cwd).toBe(PRIMARY);
        expect(world.spawns[0].argv).toEqual([process.execPath, ENTRY, LINKED, BRANCH, LINKED_HEAD]);
    });

    /**
     * THE BUG THIS FIX IS ABOUT, at this layer. An agent worktree lives INSIDE the primary clone, so
     * `pnpm` hoists the bin's cwd out of it and every cwd-derived answer names the primary clone. The
     * reap target is now the tree the RESOLVER named, so the hoisted cwd cannot change it: the child is
     * still handed the worktree, its branch and its sha, and still runs from the primary clone.
     */
    it('reaps the resolved worktree even when the process cwd was hoisted to the primary clone', () => {
        const reaper = built();

        const handoff = reaper.plan(PRIMARY, landedTree(), PRIMARY) as WorktreeReapHandoff;

        expect(handoff.canReap).toBe(true);
        expect(handoff.worktreePath).toBe(LINKED);
        // …and the operator's own shell was never inside it, so they must NOT be told to move.
        expect(handoff.standingHere).toBe(false);
        world.childStdout = new ReapOutcomeSignal().line(REAP_OUTCOME_REMOVED);
        const out = reaper.handOff(handoff);
        expect(out).not.toContain('NO LONGER EXISTS');
        expect(world.spawns[0].argv).toEqual([process.execPath, ENTRY, LINKED, BRANCH, LINKED_HEAD]);
    });

    // Landing from the primary clone is the ordinary case and must not grow a special sentence — or a
    // child process. There is no worktree to remove, only a branch, which `pnpm wp-cleanup` handles.
    it('plans nothing when no worktree holds the landed commit', () => {
        expect(built().plan(PRIMARY, null, PRIMARY)).toBeNull();
        expect(world.spawns.length).toBe(0);
    });

    // The primary clone is the thing reaped FROM, never a target — so it is refused here as well as by
    // the child's own verdicts and by WorktreeReaper's name rail. None of the three is load-bearing alone.
    it('plans nothing when the resolved tree IS the primary clone', () => {
        const main = new Worktree(PRIMARY, 'main', 'aaa', true, false, false, '');

        expect(built().plan(PRIMARY, main, PRIMARY)).toBeNull();
        expect(world.spawns.length).toBe(0);
    });

    /**
     * The honest-limitation path the ticket insists on. No entry point to re-exec ⇒ do NOT half-reap,
     * do NOT spawn anything, and print the #512 notice naming the exact directory to run cleanup from.
     */
    it('keeps the manual notice, and spawns nothing, when the reap entry point is missing', () => {
        const reaper = new UnbuiltReaper(new WorktreeService(), new ReapOutcomeSignal());

        const handoff = reaper.plan(LINKED, landedTree(), LINKED) as WorktreeReapHandoff;

        expect(handoff.canReap).toBe(false);
        expect(handoff.blockedBecause).toContain('not on disk');
        expect(world.spawns.length).toBe(0);
        const notice = reaper.manualNotice(handoff);
        // Single-quoted (atRoot's format): a primary clone under a path with a space — "Google Drive",
        // "My Documents", `/Users/dean hiller/…` — makes a bare `cd` two arguments and it fails.
        expect(notice).toContain(`cd '${PRIMARY}' && pnpm wp-cleanup`);
        expect(notice).toContain(LINKED);
    });

    // Fail SAFE when git cannot name a primary clone (an unavailable git, a bare repo, a directory that
    // is not a checkout): there is then no directory the child could safely run FROM, so nothing is
    // spawned and the #512 manual notice stands instead.
    it('spawns nothing when git cannot name a primary clone to reap from', () => {
        world.porcelain = '';

        const handoff = built().plan(LINKED, landedTree(), LINKED) as WorktreeReapHandoff;

        expect(handoff.canReap).toBe(false);
        expect(handoff.blockedBecause).toContain('no safe directory');
        expect(world.spawns.length).toBe(0);
    });
});

describe('LandedWorktreeReaper — reporting what the child did', () => {
    // A successful reap deletes the directory the SHELL is sitting in. Saying so is not politeness:
    // every following relative path in that shell is an unexplained ENOENT until the human moves.
    it('tells the caller their cwd no longer exists after a successful reap', () => {
        world.childStdout = `  ✓ removed\n${new ReapOutcomeSignal().line(REAP_OUTCOME_REMOVED)}`;
        const reaper = built();

        const out = reaper.handOff(reaper.plan(LINKED, landedTree(), LINKED) as WorktreeReapHandoff);

        expect(out).toContain('NO LONGER EXISTS');
        expect(out).toContain(`cd '${PRIMARY}'`);   // quoted for the same reason as the manual notice
        expect(out).toContain('✓ removed');
        // The wire format is for the parent, not the reader — it must never surface in a recap.
        expect(out).not.toContain('WP_REAP_OUTCOME');
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

        const out = reaper.handOff(reaper.plan(LINKED, landedTree(), LINKED) as WorktreeReapHandoff);

        expect(out).toContain('contains modified or untracked files');
        expect(out).toContain('Nothing was forced');
        expect(out).toContain(`cd '${PRIMARY}' && pnpm wp-cleanup`);
        expect(out).not.toContain('--force');
    });

    /**
     * THE EXIT-CODE-ONLY BUG. The child exits 0 on a REFUSAL on purpose — it runs after a PR has already
     * merged, and a non-zero exit there would report a landed PR as a failed command. So `exit 0` means
     * "the child ran", never "the worktree is gone", and a parent that reads only the status announces a
     * removal that was explicitly refused: it prints "NO LONGER EXISTS" about a directory still on disk
     * and drops the one instruction — `pnpm wp-cleanup` from the primary clone — that would finish the job.
     */
    it('does not announce a removal when the child exited 0 but refused the reap', () => {
        world.childStatus = 0;
        world.childStdout = `\n   ⚠️  ${LINKED} is not provably dead: never had a PR; holds 3 unique commit(s)\n`
            + '       Refusing to remove a worktree that may still hold unmerged work.\n'
            + new ReapOutcomeSignal().line(REAP_OUTCOME_REFUSED);
        const reaper = built();

        const out = reaper.handOff(reaper.plan(LINKED, landedTree(), LINKED) as WorktreeReapHandoff);

        expect(out).toContain('not provably dead');           // the child's own words survive
        expect(out).not.toContain('NO LONGER EXISTS');        // …and are not contradicted
        expect(out).toContain('The worktree was NOT removed');
        expect(out).toContain("the child reported 'refused'");
        expect(out).toContain(`cd '${PRIMARY}' && pnpm wp-cleanup`);
        expect(out).not.toContain('WP_REAP_OUTCOME');
    });

    /**
     * A child that dies before it can state an outcome — killed, or crashed after printing — is not
     * evidence of a removal either. The safe reading of silence is "still on disk", because the cost of
     * being wrong the other way is telling a human their live worktree is gone.
     */
    it('treats a child that reported no outcome as a worktree still on disk', () => {
        world.childStatus = 0;
        world.childStdout = '  some output that never got to the point\n';
        const reaper = built();

        const out = reaper.handOff(reaper.plan(LINKED, landedTree(), LINKED) as WorktreeReapHandoff);

        expect(out).not.toContain('NO LONGER EXISTS');
        expect(out).toContain('without reporting an outcome');
        expect(out).toContain(`cd '${PRIMARY}' && pnpm wp-cleanup`);
    });

    // The primary clone is never the thing being removed — it is the thing being removed FROM. Nothing
    // in the argv the child is handed can name it.
    it('never hands the primary clone to the child as the removal target', () => {
        const reaper = built();

        reaper.handOff(reaper.plan(LINKED, landedTree(), LINKED) as WorktreeReapHandoff);

        expect(world.spawns[0].argv).not.toContain(PRIMARY);
        expect(world.spawns[0].argv[2]).toBe(LINKED);
    });
});
