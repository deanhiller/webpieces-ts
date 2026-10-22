import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { AgentWorktreeLockReader } from './agent-worktree-lock';
import { Worktree, WorktreeService } from './worktrees';

/**
 * The ONE real-git contract for worktree locks (#1381), against REAL git and a REAL locked worktree,
 * deliberately.
 *
 * The whole defect lived in what `git worktree list --porcelain` says about a lock the Claude Code
 * harness takes — so a hand-built porcelain fixture would only ever confirm the author's own model of
 * that output, which is precisely the thing that was wrong. These two tests prove the exact `locked
 * <reason>` / bare `locked` shape the scripted git in `agent-worktree-lock.spec.ts` answers with comes
 * out of the git that is installed; every VERDICT built on top of that output is held there, against
 * scripted git, without starting a process per assertion.
 */

let primary = '';
let worktrees = '';

function git(cwd: string, ...args: string[]): string {
    const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
    return result.stdout.trim();
}

// The reason string the Claude Code harness writes, in its exact observed shape.
function agentReason(agent: string): string {
    return `claude agent ${agent} (pid ${String(process.pid)} start Wed Aug 19 13:11:24 2026)`;
}

/** Add a worktree on a NEW branch and lock it with `reason` (null: a bare `git worktree lock`). */
function addLockedWorktree(name: string, branch: string, reason: string | null): string {
    const treePath = join(worktrees, name);
    git(primary, 'worktree', 'add', '-b', branch, treePath, 'main');
    if (reason === null) git(primary, 'worktree', 'lock', treePath);
    else git(primary, 'worktree', 'lock', '--reason', reason, treePath);
    return treePath;
}

beforeEach((): void => {
    // realpath: macOS hands out /var/... while git reports the /private/var/... it resolves to.
    primary = realpathSync(mkdtempSync(join(tmpdir(), 'agent-lock-repo-')));
    worktrees = realpathSync(mkdtempSync(join(tmpdir(), 'agent-lock-trees-')));
    git(primary, 'init', '-q', '-b', 'main');
    writeFileSync(join(primary, 'base.txt'), 'base\n', 'utf8');
    git(primary, 'add', '-A');
    git(primary, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'base');
});

afterEach((): void => {
    rmSync(primary, { recursive: true, force: true });
    rmSync(worktrees, { recursive: true, force: true });
});

describe('the lock reason comes out of real `git worktree list --porcelain`', (): void => {
    it('carries the harness reason verbatim, and parses to the agent name and pid', (): void => {
        const reason = agentReason('agent-a017f6be7c518c68c');
        const treePath = addLockedWorktree('landed', 'dean/landed', reason);

        const tree = new WorktreeService().listWorktrees(primary)
            .find((entry: Worktree): boolean => entry.path === treePath);

        expect(tree?.locked).toBe(true);
        expect(tree?.lockReason).toBe(reason);

        const lock = new AgentWorktreeLockReader().parse(tree?.lockReason ?? '');
        expect(lock?.agent).toBe('agent-a017f6be7c518c68c');
        expect(lock?.pid).toBe(process.pid);
        expect(lock?.startedAt).toBe('Wed Aug 19 13:11:24 2026');
    });

    it('reports an EMPTY lock reason as empty, not as a missing lock', (): void => {
        const treePath = addLockedWorktree('bare', 'dean/still-working', null);

        const tree = new WorktreeService().listWorktrees(primary)
            .find((entry: Worktree): boolean => entry.path === treePath);

        expect(tree?.locked).toBe(true);
        expect(tree?.lockReason).toBe('');
        expect(new AgentWorktreeLockReader().parse('')).toBeNull();
    });
});
