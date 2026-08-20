import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { AgentWorktreeLockReader } from './agent-worktree-lock';
import { branchMutationLogPath } from './branch-mutation-log';
import { DeletableWorktree, MergedBranchesService } from './merged-branches';
import { WorktreeReaper } from './worktree-reaper';
import { WorktreeService } from './worktrees';

/**
 * Against REAL git and a REAL locked worktree, deliberately.
 *
 * The whole defect lived in what `git worktree list --porcelain` says about a lock the Claude Code
 * harness took — so a hand-built porcelain fixture would only ever confirm the author's own model of
 * that output, which is precisely the thing that was wrong. Every lock reason asserted on below comes
 * back out of git, and the one reap that removes a directory removes a real one.
 *
 * `gh` is the single exception: a temp-repo has no GitHub, and "merged PR" is the proof the whole
 * verdict turns on. It is faked as an executable on PATH rather than mocked in-process, so the code
 * under test still spawns a subprocess and parses its stdout exactly as it does in the field.
 */

let primary = '';
let worktrees = '';
let fakeBin = '';
let originalPath = '';

const MERGED_BRANCH = 'dean/landed';
const MERGED_PR = 999;
const LIVE_BRANCH = 'dean/still-working';

function git(cwd: string, ...args: string[]): string {
    const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
    return result.stdout.trim();
}

/**
 * A pid that is definitively NOT running: fork a trivial child, wait for it to exit, then reuse its
 * number. Hardcoding one and hoping is the failure mode this exists to avoid.
 */
function deadPid(): number {
    const child = spawnSync(process.execPath, ['-e', 'process.exit(0)'], { encoding: 'utf8' });
    if (typeof child.pid !== 'number') throw new Error('could not spawn a child to harvest a dead pid');
    return child.pid;
}

// The reason string the Claude Code harness writes, in its exact observed shape.
function agentReason(agent: string, pid: number): string {
    return `claude agent ${agent} (pid ${String(pid)} start Wed Aug 19 13:11:24 2026)`;
}

/** Add a worktree on a NEW branch, with one commit on it, and lock it with `reason`. */
function addLockedWorktree(name: string, branch: string, reason: string | null): string {
    const treePath = join(worktrees, name);
    git(primary, 'worktree', 'add', '-b', branch, treePath, 'main');
    writeFileSync(join(treePath, `${name}.txt`), 'work\n', 'utf8');
    git(treePath, 'add', '-A');
    git(treePath, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', `work on ${branch}`);
    if (reason === null) git(primary, 'worktree', 'lock', treePath);
    else git(primary, 'worktree', 'lock', '--reason', reason, treePath);
    return treePath;
}

function verdictFor(treePath: string): DeletableWorktree {
    const found = new MergedBranchesService().computeMergedBranches(primary).worktrees
        .find((tree: DeletableWorktree): boolean => tree.path === treePath);
    if (found === undefined) throw new Error(`no verdict recorded for ${treePath}`);
    return found;
}

beforeEach((): void => {
    // realpath: macOS hands out /var/... while git reports the /private/var/... it resolves to, and
    // every assertion here compares paths against git's own output.
    primary = realpathSync(mkdtempSync(join(tmpdir(), 'agent-lock-repo-')));
    worktrees = realpathSync(mkdtempSync(join(tmpdir(), 'agent-lock-trees-')));
    git(primary, 'init', '-q', '-b', 'main');
    writeFileSync(join(primary, 'base.txt'), 'base\n', 'utf8');
    git(primary, 'add', '-A');
    git(primary, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'base');

    // `gh pr list` reports MERGED_BRANCH as merged, and nothing else.
    fakeBin = realpathSync(mkdtempSync(join(tmpdir(), 'agent-lock-bin-')));
    const merged = JSON.stringify([{ number: MERGED_PR, headRefName: MERGED_BRANCH }]);
    const all = JSON.stringify([{ number: MERGED_PR, headRefName: MERGED_BRANCH, state: 'MERGED' }]);
    writeFileSync(
        join(fakeBin, 'gh'),
        `#!/bin/sh\ncase "$*" in\n  *"--state all"*) echo '${all}' ;;\n  *) echo '${merged}' ;;\nesac\n`,
        'utf8',
    );
    chmodSync(join(fakeBin, 'gh'), 0o755);
    originalPath = process.env.PATH ?? '';
    process.env.PATH = `${fakeBin}:${originalPath}`;
});

afterEach((): void => {
    process.env.PATH = originalPath;
    rmSync(primary, { recursive: true, force: true });
    rmSync(worktrees, { recursive: true, force: true });
    rmSync(fakeBin, { recursive: true, force: true });
});

describe('the lock reason comes out of real `git worktree list --porcelain`', (): void => {
    it('carries the harness reason verbatim, and parses to the agent name and pid', (): void => {
        const reason = agentReason('agent-a017f6be7c518c68c', 64914);
        const treePath = addLockedWorktree('landed', MERGED_BRANCH, reason);

        const tree = new WorktreeService().listWorktrees(primary)
            .find((entry): boolean => entry.path === treePath);

        expect(tree?.locked).toBe(true);
        expect(tree?.lockReason).toBe(reason);

        const lock = new AgentWorktreeLockReader().parse(tree?.lockReason ?? '');
        expect(lock?.agent).toBe('agent-a017f6be7c518c68c');
        expect(lock?.pid).toBe(64914);
        expect(lock?.startedAt).toBe('Wed Aug 19 13:11:24 2026');
    });

    it('reports an EMPTY lock reason as empty, not as a missing lock', (): void => {
        const treePath = addLockedWorktree('bare', LIVE_BRANCH, null);

        const tree = new WorktreeService().listWorktrees(primary)
            .find((entry): boolean => entry.path === treePath);

        expect(tree?.locked).toBe(true);
        expect(tree?.lockReason).toBe('');
        expect(new AgentWorktreeLockReader().parse('')).toBeNull();
    });

    // process.pid is definitionally alive; the harvested child pid is definitionally not.
    it('judges liveness off the pid in the reason', (): void => {
        const reader = new AgentWorktreeLockReader();
        const live = reader.parse(agentReason('agent-live', process.pid));
        const gone = reader.parse(agentReason('agent-gone', deadPid()));

        expect(live !== null && reader.isRunning(live)).toBe(true);
        expect(gone !== null && reader.isRunning(gone)).toBe(false);
    });
});

describe('wp-cleanup verdicts for a locked worktree', (): void => {
    it('SPARES an agent lock whose pid is still running, naming the agent and the pid', (): void => {
        const treePath = addLockedWorktree('live', MERGED_BRANCH, agentReason('agent-live', process.pid));

        const verdict = verdictFor(treePath);

        expect(verdict.deletable).toBe(false);
        expect(verdict.unlockBeforeRemove).toBe(false);
        expect(verdict.reason).toContain('agent-live');
        expect(verdict.reason).toContain(`pid ${String(process.pid)}`);
        expect(verdict.reason).toContain('still running');
    });

    it('marks an agent lock whose pid is GONE deletable when its branch is merged', (): void => {
        const pid = deadPid();
        const treePath = addLockedWorktree('landed', MERGED_BRANCH, agentReason('agent-dead', pid));

        const verdict = verdictFor(treePath);

        expect(verdict.deletable).toBe(true);
        expect(verdict.unlockBeforeRemove).toBe(true);
        expect(verdict.pr).toBe(MERGED_PR);
        expect(verdict.reason).toContain(`PR #${String(MERGED_PR)} merged`);
        expect(verdict.reason).toContain('agent-dead');
        expect(verdict.reason).toContain(`pid ${String(pid)} is gone`);
        expect(verdict.reason).toContain('stale lock');
    });

    // The asymmetry: a dead agent is not a licence to delete unmerged work, only to stop pretending
    // the lock protects anything.
    it('SPARES an agent lock whose pid is gone when the branch is NOT provably merged', (): void => {
        const treePath = addLockedWorktree('unmerged', LIVE_BRANCH, agentReason('agent-dead', deadPid()));

        const verdict = verdictFor(treePath);

        expect(verdict.deletable).toBe(false);
        expect(verdict.reason).toContain('agent-dead');
    });

    /**
     * Dean's rule, and the reason the old message was a defect twice over: the lock reason is the only
     * evidence of who locked a worktree, and an unrecognised one identifies nobody. A human may have
     * written it; so may some other tool. Report the string, attribute it to no one.
     */
    it('SPARES an unrecognised lock reason, quoting it and attributing it to NOBODY', (): void => {
        const treePath = addLockedWorktree('debugging', MERGED_BRANCH, 'dean is debugging');

        const verdict = verdictFor(treePath);

        expect(verdict.deletable).toBe(false);
        expect(verdict.unlockBeforeRemove).toBe(false);
        expect(verdict.reason).toContain('dean is debugging');
        expect(verdict.reason).not.toContain('human');
    });

    it('SPARES a lock with no reason at all, and says so rather than guessing', (): void => {
        const treePath = addLockedWorktree('bare', MERGED_BRANCH, null);

        const verdict = verdictFor(treePath);

        expect(verdict.deletable).toBe(false);
        expect(verdict.unlockBeforeRemove).toBe(false);
        expect(verdict.reason).toContain('no reason recorded');
        expect(verdict.reason).not.toContain('human');
    });
});

describe('reaping a dead agent\'s merged worktree', (): void => {
    it('unlocks it, removes the directory and the branch, and logs the SHA and a recover= command', (): void => {
        const treePath = addLockedWorktree('landed', MERGED_BRANCH, agentReason('agent-dead', deadPid()));
        const tip = git(primary, 'rev-parse', MERGED_BRANCH);
        const verdict = verdictFor(treePath);

        const result = new WorktreeReaper().reapWorktrees(primary, primary, 'wp-cleanup', [verdict]);

        expect(result.failed).toEqual([]);
        expect(result.reaped.length).toBe(1);
        expect(result.reaped[0].sha).toBe(tip);
        expect(result.reaped[0].branchDeleted).toBe(true);

        // The directory and the branch are both actually gone from real git.
        expect(git(primary, 'worktree', 'list', '--porcelain')).not.toContain(treePath);
        expect(git(primary, 'branch', '--list', MERGED_BRANCH)).toBe('');

        // Every removal stays recoverable — that guarantee is unchanged by the unlock.
        const restore = new WorktreeReaper().restoreCommand(result.reaped[0]);
        expect(restore).toContain(`git worktree add -b ${MERGED_BRANCH} ${treePath}`);

        const log = readFileSync(branchMutationLogPath(primary), 'utf8');
        expect(log).toContain('REAP_WORKTREE');
        expect(log).toContain(tip);
        expect(log).toContain(`recover=git worktree add -b ${MERGED_BRANCH} ${treePath}`);
        expect(log).toContain('unlocked stale agent lock');
    });

    // The reap is the ONLY thing that clears a lock, and only for a verdict that earned it. A lock the
    // verdict never flagged must still stop the removal dead — otherwise `unlockBeforeRemove` would be
    // decoration rather than the gate it is.
    it('does NOT unlock a worktree whose verdict never asked for it', (): void => {
        const treePath = addLockedWorktree('landed', MERGED_BRANCH, 'dean is debugging');
        const forced = new DeletableWorktree(
            treePath, MERGED_BRANCH, `PR #${String(MERGED_PR)} merged`, MERGED_PR, true, 'merged-pr');

        const result = new WorktreeReaper().reapWorktrees(primary, primary, 'wp-cleanup', [forced]);

        expect(result.reaped).toEqual([]);
        expect(result.failed.length).toBe(1);
        expect(result.failed[0].error).toContain('locked');
        expect(git(primary, 'worktree', 'list', '--porcelain')).toContain(treePath);
    });
});

// The reaper's own rails are unrelated to locking and must not have moved.
describe('the standing-in-it rail is untouched', (): void => {
    it('refuses to reap the worktree the command is running in, lock or no lock', (): void => {
        const treePath = addLockedWorktree('landed', MERGED_BRANCH, agentReason('agent-dead', deadPid()));
        const verdict = verdictFor(treePath);

        const result = new WorktreeReaper().reapWorktrees(primary, treePath, 'wp-cleanup', [verdict]);

        expect(result.reaped).toEqual([]);
        expect(result.spared.length).toBe(1);
        expect(result.spared[0].reason).toContain('self-destruct');
        expect(git(primary, 'worktree', 'list', '--porcelain')).toContain(treePath);
    });
});
