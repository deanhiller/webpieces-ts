import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * The CHILD half of wp-land-pr's re-exec, end to end through the REAL WorktreeReaper: given a path and
 * a branch, does it archive → `git worktree remove` → `git branch -D`, in that order, refuse everything
 * it should refuse, and leave a `recover=` line that actually restores the branch?
 *
 * Only git is faked. The mutation log is written to a real temp directory on purpose — the `recover=`
 * line is the single thing standing between a removed directory and a lost branch, and asserting it
 * against the bytes that reach disk is the only assertion worth making about it.
 */
const world = vi.hoisted(() => ({
    porcelain: '',
    removeFails: {} as Record<string, string>,
    calls: [] as string[],
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
            // No tag pre-exists in this world, so the archiver's collision probe always misses.
            if (args[1] === '--verify') return { status: 1, stdout: '', stderr: '' };
            return { status: 0, stdout: `sha-${String(args[1])}`, stderr: '' };
        }
        return { status: 0, stdout: '', stderr: '' };
    },
    execSync: (): string => '',
}));

import {
    BranchMutationLog,
    CLASSIFICATION_CURRENT,
    CLASSIFICATION_MERGED_PR,
    CLASSIFICATION_NEVER_PROPOSED,
    DeletableWorktree,
    MergedBranchesService,
    RepoRootFinder,
    WorktreeReaper,
    WorktreeService,
    branchMutationLogPath,
} from '@webpieces/rules-config';

import {
    ReapOutcomeSignal,
    REAP_OUTCOME_FAILED,
    REAP_OUTCOME_REFUSED,
    REAP_OUTCOME_REMOVED,
} from '../workflow/reap-outcome';

import { ReapWorktreeCommand } from './reap-worktree-command';
import { WorktreeCleanupSection } from './worktree-cleanup';

const BRANCH = 'dean/reap';
let primary = '';
let linked = '';
let verdicts: DeletableWorktree[] = [];
let out = '';

// `verdicts` is the seam: MergedBranchesService's own spec covers how a verdict is reached, and this
// spec is about what the command DOES with one. The reap below is the real WorktreeReaper.
class ScriptedSection extends WorktreeCleanupSection {
    verdicts(): DeletableWorktree[] {
        return verdicts;
    }
}

class FakeRepoRootFinder extends RepoRootFinder {
    resolveRepoRoot(): string {
        return primary;
    }
}

function build(): ReapWorktreeCommand {
    return new ReapWorktreeCommand(
        new FakeRepoRootFinder(),
        new ScriptedSection(new MergedBranchesService(), new WorktreeReaper(), new WorktreeService(), new BranchMutationLog()),
        new ReapOutcomeSignal());
}

// The outcome token the parent reads — asserted on every exit path, because it is the ONLY thing that
// distinguishes this command's exit-0 refusals from its exit-0 successes.
function outcome(report: string): string {
    return new ReapOutcomeSignal().read(report).outcome;
}

function merged(): DeletableWorktree {
    return new DeletableWorktree(linked, BRANCH, 'PR #999 merged', 999, true, CLASSIFICATION_MERGED_PR);
}

async function run(args: string[]): Promise<string> {
    const original = process.stdout.write.bind(process.stdout);
    // webpieces-disable no-any-unknown -- stubbing node's write signature for the duration of one run
    (process.stdout as unknown as { write: (chunk: string) => boolean }).write = (chunk: string): boolean => {
        out += chunk;
        return true;
    };
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        await build().run(args);
    } finally {
        (process.stdout as unknown as { write: typeof original }).write = original;
    }
    return out;
}

function logText(): string {
    const file = branchMutationLogPath(primary);
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

// The git steps that destroy something, in the order git was asked to run them.
function destructiveCalls(): string[] {
    return world.calls.filter((call: string): boolean =>
        call.startsWith('tag ') || call.startsWith('worktree remove') || call.startsWith('branch -D'));
}

beforeEach(() => {
    primary = fs.mkdtempSync(path.join(os.tmpdir(), 'wpr-'));
    linked = path.join(path.dirname(primary), `${path.basename(primary)}-feature`);
    world.porcelain = `worktree ${primary}\nHEAD aaa\nbranch refs/heads/main\n\n`
        + `worktree ${linked}\nHEAD bbb\nbranch refs/heads/${BRANCH}\n`;
    world.removeFails = {};
    world.calls = [];
    verdicts = [merged()];
    out = '';
});

afterEach(() => {
    fs.rmSync(primary, { recursive: true, force: true });
});

describe('ReapWorktreeCommand — the reap wp-land-pr hands off', () => {
    /**
     * The whole ticket, proven from the child's entry point: the worktree that held the just-landed
     * branch is archived, removed and its branch deleted — in that order, which is the only order that
     * works (archive before anything is destroyed; remove the directory before git will let the branch go).
     */
    it('archives, removes the worktree, then deletes the branch', async () => {
        const report = await run([linked, BRANCH]);

        expect(outcome(report)).toBe(REAP_OUTCOME_REMOVED);
        const ordered = destructiveCalls();
        expect(ordered.length).toBe(3);
        expect(ordered[0]).toMatch(new RegExp(`^tag archive/\\d{4}-\\d{2}-\\d{2}/${BRANCH} `));
        expect(ordered[1]).toBe(`worktree remove ${linked}`);
        expect(ordered[2]).toBe(`branch -D ${BRANCH}`);
    });

    /**
     * `-b` is the load-bearing token. `git worktree add <path> <tag>` restores the FILES at a detached
     * HEAD and silently loses the branch name, so a recover line in that form restores half of what was
     * destroyed while reading as complete.
     */
    it('logs REAP_WORKTREE with a recover= line that carries -b <branch>', async () => {
        await run([linked, BRANCH]);

        const line = logText();
        expect(line).toContain('wp-land-pr');
        expect(line).toContain('REAP_WORKTREE');
        expect(line).toContain(`worktree=${linked}`);
        expect(line).toMatch(
            new RegExp(`recover=git worktree add -b ${BRANCH} ${linked} archive/\\d{4}-\\d{2}-\\d{2}/${BRANCH}`));
    });

    /**
     * Git's refusal to remove a worktree holding uncommitted or untracked files is the safety property,
     * not an obstacle. It is reported with git's own words, the branch is left alone, and `--force`
     * appears in no code path — an untracked file is work no archive tag captured.
     */
    it('reports a worktree with uncommitted changes as a clean failure and never forces', async () => {
        world.removeFails = { [linked]: `fatal: '${linked}' contains modified or untracked files` };

        const report = await run([linked, BRANCH]);

        expect(outcome(report)).toBe(REAP_OUTCOME_FAILED);
        expect(report).toContain('contains modified or untracked files');
        expect(report).toContain('not forced');
        expect(world.calls.join('\n')).not.toContain('--force');
        expect(world.calls).not.toContain(`branch -D ${BRANCH}`);
    });
});

describe('ReapWorktreeCommand — what it refuses', () => {
    /**
     * The primary clone is never removable. It is not in the verdicts at all (classifyWorktrees drops
     * the main worktree outright), so a caller naming it simply finds no target — and WorktreeReaper
     * would refuse it a second time by name if it ever got that far.
     */
    it('removes nothing when asked to reap the primary clone', async () => {
        const report = await run([primary, 'main']);

        expect(outcome(report)).toBe(REAP_OUTCOME_REFUSED);
        expect(report).toContain('not a removable worktree');
        expect(world.calls.join('\n')).not.toContain('worktree remove');
    });

    // The verdict is recomputed here and believed over the caller: a tree whose branch is not provably
    // merged may still hold the only copy of somebody's work.
    it('refuses a worktree that is not provably dead', async () => {
        verdicts = [new DeletableWorktree(
            linked, BRANCH, 'never had a PR; holds 3 unique commit(s)', 0, false, CLASSIFICATION_NEVER_PROPOSED)];

        const report = await run([linked, BRANCH]);

        expect(outcome(report)).toBe(REAP_OUTCOME_REFUSED);
        expect(report).toContain('not provably dead');
        expect(report).toContain('may still hold unmerged work');
        expect(world.calls.join('\n')).not.toContain('worktree remove');
    });

    // Somebody checked something else out there between the landing and the reap. Whatever that is, it
    // is not the corpse we were sent to bury.
    it('refuses when the worktree now holds a different branch', async () => {
        verdicts = [new DeletableWorktree(
            linked, 'dean/other', 'PR #1 merged', 1, true, CLASSIFICATION_MERGED_PR)];

        const report = await run([linked, BRANCH]);

        expect(outcome(report)).toBe(REAP_OUTCOME_REFUSED);
        expect(report).toContain("now holds 'dean/other'");
        expect(world.calls.join('\n')).not.toContain('worktree remove');
    });

    // The reaper's own cwd rail, reached through the command: if this child somehow ended up INSIDE
    // the tree it was told to remove, the removal is a self-destruct and is refused.
    it('refuses to remove the tree it is itself standing in', async () => {
        verdicts = [new DeletableWorktree(
            primary, 'main', 'PR #999 merged', 999, true, CLASSIFICATION_CURRENT)];

        const report = await run([primary, 'main']);

        expect(world.calls.join('\n')).not.toContain('worktree remove');
        expect(outcome(report)).toBe(REAP_OUTCOME_REFUSED);
        expect(report).toContain('Nothing removed');
    });

    // Missing argv is a broken caller, not a landed PR being misreported — it throws rather than
    // printing, and nothing git-destructive runs first.
    it('refuses to run without both a path and a branch', async () => {
        await expect(run([linked])).rejects.toThrow(/missing arguments/);
        expect(world.calls.length).toBe(0);
    });
});
