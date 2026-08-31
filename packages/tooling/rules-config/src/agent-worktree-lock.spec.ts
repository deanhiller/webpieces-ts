import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
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
 * harness takes — so a hand-built porcelain fixture would only ever confirm the author's own model of
 * that output, which is precisely the thing that was wrong. Every lock reason asserted on below comes
 * back out of git, and the one reap that removes a directory removes a real one.
 *
 * TWO fakes, both for things a temp repo cannot have:
 *  - `gh`, because a temp repo has no GitHub and "merged PR" is the proof the whole verdict turns on.
 *    Faked as an executable on PATH rather than mocked in-process, so the code under test still spawns
 *    a subprocess and parses its stdout exactly as it does in the field.
 *  - `$CLAUDE_CONFIG_DIR`, pointed at a temp tree holding fixture agent transcripts. Reading the real
 *    `~/.claude` would make these assertions depend on whatever agents happened to be running.
 */

let primary = '';
let worktrees = '';
let fakeBin = '';
let configDir = '';
let subagents = '';
let originalPath = '';
let originalConfigDir: string | undefined;

const MERGED_BRANCH = 'dean/landed';
const MERGED_PR = 999;
const LIVE_BRANCH = 'dean/still-working';

function git(cwd: string, ...args: string[]): string {
    const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
    return result.stdout.trim();
}

// The reason string the Claude Code harness writes, in its exact observed shape. The pid is REAL and
// alive on purpose: it is the shared session pid in the field, and the point of this change is that
// its liveness decides nothing.
function agentReason(agent: string): string {
    return `claude agent ${agent} (pid ${String(process.pid)} start Wed Aug 19 13:11:24 2026)`;
}

/**
 * Fixture harness state for one agent. `lastBlock` is the content block its transcript ends on —
 * `text` for an agent that returned, `tool_use` for one still inside a tool call.
 */
function writeAgentState(agent: string, worktreePath: string, lastBlock: string): void {
    writeFileSync(join(subagents, `${agent}.meta.json`),
        JSON.stringify({ agentType: 'general-purpose', worktreePath, spawnedWithWorktree: true }), 'utf8');
    writeFileSync(join(subagents, `${agent}.jsonl`),
        `{"type":"assistant","message":{"content":[{"type":"${lastBlock}"}]}}\n`, 'utf8');
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

function verdictFor(treePath: string, ignoreStaleLocks: boolean = false): DeletableWorktree {
    const found = new MergedBranchesService().computeMergedBranches(primary, ignoreStaleLocks).worktrees
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

    // An EMPTY harness state tree by default: "the harness knows nothing about that agent", which is
    // the honest default for a temp repo and exercises the fail-safe path.
    configDir = realpathSync(mkdtempSync(join(tmpdir(), 'agent-lock-claude-')));
    subagents = join(configDir, 'projects', '-tmp-repo', 'session-1', 'subagents');
    mkdirSync(subagents, { recursive: true });
    originalConfigDir = process.env['CLAUDE_CONFIG_DIR'];
    process.env['CLAUDE_CONFIG_DIR'] = configDir;
});

afterEach((): void => {
    process.env.PATH = originalPath;
    if (originalConfigDir === undefined) delete process.env['CLAUDE_CONFIG_DIR'];
    else process.env['CLAUDE_CONFIG_DIR'] = originalConfigDir;
    rmSync(primary, { recursive: true, force: true });
    rmSync(worktrees, { recursive: true, force: true });
    rmSync(fakeBin, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
});

describe('the lock reason comes out of real `git worktree list --porcelain`', (): void => {
    it('carries the harness reason verbatim, and parses to the agent name and pid', (): void => {
        const reason = agentReason('agent-a017f6be7c518c68c');
        const treePath = addLockedWorktree('landed', MERGED_BRANCH, reason);

        const tree = new WorktreeService().listWorktrees(primary)
            .find((entry): boolean => entry.path === treePath);

        expect(tree?.locked).toBe(true);
        expect(tree?.lockReason).toBe(reason);

        const lock = new AgentWorktreeLockReader().parse(tree?.lockReason ?? '');
        expect(lock?.agent).toBe('agent-a017f6be7c518c68c');
        expect(lock?.pid).toBe(process.pid);
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
});

describe('wp-cleanup verdicts for a locked worktree', (): void => {
    /**
     * THE BUG, pinned. Every worktree in a session records the SAME pid — the session process — so
     * `process.pid` here is exactly what the field sees, and it is ALIVE. The verdict must still be
     * deletable, and the reason must not claim anybody is working anywhere.
     */
    it('reaps a merged worktree whose agent has RETURNED, whatever the live pid in the lock says', (): void => {
        const treePath = addLockedWorktree('landed', MERGED_BRANCH, agentReason('agent-done'));
        writeAgentState('agent-done', treePath, 'text');

        const verdict = verdictFor(treePath);

        expect(verdict.deletable).toBe(true);
        expect(verdict.unlockBeforeRemove).toBe(true);
        expect(verdict.pr).toBe(MERGED_PR);
        expect(verdict.reason).toContain(`PR #${String(MERGED_PR)} merged`);
        expect(verdict.reason).toContain('agent-done');
        expect(verdict.reason).not.toContain('still running');
    });

    // "The harness has never heard of that agent" is not a veto — an unreadable ~/.claude would
    // otherwise restore the exact accumulation this change exists to end. The branch evidence is what
    // licensed this reap; the harness only ever gets to stop one.
    it('reaps a merged worktree when the harness knows nothing about its agent', (): void => {
        const treePath = addLockedWorktree('landed', MERGED_BRANCH, agentReason('agent-unknown'));

        const verdict = verdictFor(treePath);

        expect(verdict.deletable).toBe(true);
        expect(verdict.unlockBeforeRemove).toBe(true);
    });

    it('SPARES a merged worktree whose agent is still mid-tool-call', (): void => {
        const treePath = addLockedWorktree('landed', MERGED_BRANCH, agentReason('agent-live'));
        writeAgentState('agent-live', treePath, 'tool_use');

        const verdict = verdictFor(treePath);

        expect(verdict.deletable).toBe(false);
        expect(verdict.unlockBeforeRemove).toBe(false);
        expect(verdict.reason).toContain('agent-live');
        expect(verdict.reason).toContain('working in here');
    });

    // The case the lock exists for. Uncommitted or untracked files are work no archive tag captures,
    // and nothing — not a merged PR, not a returned agent — overrides that.
    it('SPARES a merged worktree that has uncommitted work in it', (): void => {
        const treePath = addLockedWorktree('landed', MERGED_BRANCH, agentReason('agent-done'));
        writeAgentState('agent-done', treePath, 'text');
        writeFileSync(join(treePath, 'half-finished.txt'), 'not committed\n', 'utf8');

        const verdict = verdictFor(treePath);

        expect(verdict.deletable).toBe(false);
        expect(verdict.reason).toContain('uncommitted or untracked files');
    });

    /**
     * The asymmetry: a returned agent is not a licence to delete unmerged work, only to stop
     * pretending the lock protects it. And the message says only what is KNOWN — it replaced
     * "pid N still running — that agent is working in here", which was asserted as fact about seven
     * agents that had finished, several with merged PRs.
     */
    it('SPARES an unmerged worktree and does NOT claim anyone is working in it', (): void => {
        const treePath = addLockedWorktree('unmerged', LIVE_BRANCH, agentReason('agent-done'));
        writeAgentState('agent-done', treePath, 'text');

        const verdict = verdictFor(treePath);

        expect(verdict.deletable).toBe(false);
        expect(verdict.reason).toContain('agent-done');
        expect(verdict.reason).toContain('cannot be verified');
        expect(verdict.reason).toContain('shared Claude Code session process');
        expect(verdict.reason).not.toContain('working in here');
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

/**
 * `--ignore-stale-locks`: one flag in place of N hand-run `git worktree unlock`s.
 *
 * What it moves is narrow and deliberate — a locked worktree whose branch is not provably dead stops
 * being reported as merely LOCKED and is judged on its real branch and commit state, so it can reach
 * the husk reap or the numbered block a human answers. What it does NOT move is the dirty rail and
 * the live-agent veto.
 */
describe('--ignore-stale-locks', (): void => {
    it('judges a locked, unmerged worktree on its branch instead of hiding it behind the lock', (): void => {
        const treePath = addLockedWorktree('unmerged', LIVE_BRANCH, agentReason('agent-done'));
        writeAgentState('agent-done', treePath, 'text');

        const spared = verdictFor(treePath);
        const judged = verdictFor(treePath, true);

        expect(spared.classification).toBe('locked-worktree');
        expect(judged.classification).not.toBe('locked-worktree');
        expect(judged.unlockBeforeRemove).toBe(true);
        expect(judged.reason).toContain('treated as no evidence, as asked');
    });

    it('still spares a DIRTY worktree', (): void => {
        const treePath = addLockedWorktree('unmerged', LIVE_BRANCH, agentReason('agent-done'));
        writeAgentState('agent-done', treePath, 'text');
        writeFileSync(join(treePath, 'half-finished.txt'), 'not committed\n', 'utf8');

        const verdict = verdictFor(treePath, true);

        expect(verdict.deletable).toBe(false);
        expect(verdict.classification).toBe('locked-worktree');
        expect(verdict.reason).toContain('uncommitted or untracked files');
    });

    it('still spares a worktree whose agent is mid-tool-call', (): void => {
        const treePath = addLockedWorktree('unmerged', LIVE_BRANCH, agentReason('agent-live'));
        writeAgentState('agent-live', treePath, 'tool_use');

        const verdict = verdictFor(treePath, true);

        expect(verdict.deletable).toBe(false);
        expect(verdict.classification).toBe('locked-worktree');
        expect(verdict.reason).toContain('working in here');
    });
});

describe('reaping a returned agent\'s merged worktree', (): void => {
    it('unlocks it, removes the directory and the branch, and logs the SHA and a recover= command', (): void => {
        const treePath = addLockedWorktree('landed', MERGED_BRANCH, agentReason('agent-done'));
        writeAgentState('agent-done', treePath, 'text');
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
        const treePath = addLockedWorktree('landed', MERGED_BRANCH, agentReason('agent-done'));
        writeAgentState('agent-done', treePath, 'text');
        const verdict = verdictFor(treePath);

        const result = new WorktreeReaper().reapWorktrees(primary, treePath, 'wp-cleanup', [verdict]);

        expect(result.reaped).toEqual([]);
        expect(result.spared.length).toBe(1);
        expect(result.spared[0].reason).toContain('self-destruct');
        expect(git(primary, 'worktree', 'list', '--porcelain')).toContain(treePath);
    });
});
