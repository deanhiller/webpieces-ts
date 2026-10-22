import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { GitResultDto, ProcessResultDto } from '@webpieces/tooling-common';
import { ProcessCallDto, specTempDirs } from '@webpieces/tooling-testkit';

import { WorkflowFeature } from './__tests__/workflow-feature';
import { branchMutationLogPath } from './branch-mutation-log';
import { DeletableWorktree } from './merged-branch-verdicts';
import { MergedBranchesService } from './merged-branches';
import { WorktreeReaper } from './worktree-reaper';

/**
 * The verdicts and the reap for a LOCKED worktree, against scripted git (#1381).
 *
 * What `git worktree list --porcelain` prints for a harness lock — `locked <reason>`, or a bare `locked`
 * — is proven against the installed git by `agent-worktree-lock.real-git.spec.ts`; this suite answers
 * with exactly that shape and holds every decision built on top of it. Each scenario starts no process:
 * the git and `gh` the program asks are answered from {@link GitWorld}, and the reap is asserted on the
 * commands it ISSUED (unlock, remove, `branch -D`) — the statement about this program — rather than on
 * what a scratch repository looks like afterwards.
 *
 * `$CLAUDE_CONFIG_DIR` is pointed at a temp tree holding fixture agent transcripts. Reading the real
 * `~/.claude` would make these assertions depend on whatever agents happened to be running.
 */

const MERGED_BRANCH = 'dean/landed';
const MERGED_PR = 999;
const LIVE_BRANCH = 'dean/still-working';

/** One linked worktree git knows about. Data only. */
class TreeState {
    constructor(
        readonly path: string,
        readonly branch: string,
        readonly tip: string,
        // undefined: not locked. '': locked with no reason. Otherwise the reason verbatim.
        public lockReason: string | undefined,
        public dirty = false,
    ) {}
}

/** What git and `gh` know about this repo, and the answers the mocked edges give from it. */
class GitWorld {
    readonly trees: TreeState[] = [];

    constructor(readonly primary: string) {}

    git(call: ProcessCallDto): GitResultDto {
        const args = call.args;
        if (args[0] === 'worktree' && args[1] === 'list') return new GitResultDto(0, this.porcelain(), '');
        if (args[0] === 'for-each-ref') {
            return new GitResultDto(0, this.trees.map((tree: TreeState): string => tree.branch).join('\n') + '\n', '');
        }
        if (args[0] === 'status') {
            const tree = this.trees.find((entry: TreeState): boolean => entry.path === call.cwd);
            return new GitResultDto(0, tree?.dirty === true ? '?? half-finished.txt\n' : '', '');
        }
        if (args[0] === 'rev-list') return new GitResultDto(0, '1', '');
        if (args[0] === 'cherry') return new GitResultDto(0, '+ aaa\n', '');
        if (args[0] === 'show-ref') return new GitResultDto(1, '', '');
        if (args[0] === 'rev-parse') return this.revParse(args);
        if (args[0] === 'tag' || args[0] === 'branch') return new GitResultDto(0, '', '');
        if (args[0] === 'worktree' && args[1] === 'unlock') {
            const tree = this.tree(args[2]);
            if (tree !== undefined) tree.lockReason = undefined;
            return new GitResultDto(0, '', '');
        }
        if (args[0] === 'worktree' && args[1] === 'remove') {
            const tree = this.tree(args[2]);
            if (tree?.lockReason !== undefined) {
                return new GitResultDto(128, '', `fatal: cannot remove a locked working tree, lock reason: ${tree.lockReason}`);
            }
            return new GitResultDto(0, '', '');
        }
        return new GitResultDto(1, '', `unscripted git ${args.join(' ')}`);
    }

    // `gh pr list` reports MERGED_BRANCH as merged, and nothing else.
    gh(call: ProcessCallDto): ProcessResultDto {
        const all = call.args.includes('all');
        const row = all
            ? `[{"number":${String(MERGED_PR)},"headRefName":"${MERGED_BRANCH}","state":"MERGED"}]`
            : `[{"number":${String(MERGED_PR)},"headRefName":"${MERGED_BRANCH}"}]`;
        return new ProcessResultDto(0, row, '');
    }

    private revParse(args: readonly string[]): GitResultDto {
        // The archiver's tag-collision probe: no archive tag pre-exists in this repo.
        if (args[1] === '--verify') return new GitResultDto(1, '', '');
        const ref = args[args.length - 1];
        const tree = this.trees.find((entry: TreeState): boolean => entry.branch === ref);
        return tree === undefined ? new GitResultDto(128, '', 'unknown revision') : new GitResultDto(0, tree.tip, '');
    }

    private tree(treePath: string | undefined): TreeState | undefined {
        return this.trees.find((entry: TreeState): boolean => entry.path === treePath);
    }

    private porcelain(): string {
        let out = `worktree ${this.primary}\nHEAD base\nbranch refs/heads/main\n`;
        for (const tree of this.trees) {
            out += `\nworktree ${tree.path}\nHEAD ${tree.tip}\nbranch refs/heads/${tree.branch}\n`;
            if (tree.lockReason === '') out += 'locked\n';
            else if (tree.lockReason !== undefined) out += `locked ${tree.lockReason}\n`;
        }
        return out;
    }
}

let primary = '';
let worktrees = '';
let configDir = '';
let subagents = '';
let originalConfigDir: string | undefined;
let world: GitWorld;
let feature: WorkflowFeature;

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

/** A worktree on a NEW branch, with one commit on it, locked with `reason` (null: a bare lock). */
function addLockedWorktree(name: string, branch: string, reason: string | null): string {
    const treePath = join(worktrees, name);
    mkdirSync(treePath, { recursive: true });
    world.trees.push(new TreeState(treePath, branch, `tip-of-${name}`, reason === null ? '' : reason));
    return treePath;
}

// Uncommitted work in a worktree: what `git status --porcelain` reports there.
function leaveUncommittedWork(treePath: string): void {
    const tree = world.trees.find((entry: TreeState): boolean => entry.path === treePath);
    if (tree !== undefined) tree.dirty = true;
}

async function verdictFor(treePath: string, ignoreStaleLocks: boolean = false): Promise<DeletableWorktree> {
    const found = (await feature.container.get(MergedBranchesService).computeMergedBranches(primary, ignoreStaleLocks))
        .worktrees.find((tree: DeletableWorktree): boolean => tree.path === treePath);
    if (found === undefined) throw new Error(`no verdict recorded for ${treePath}`);
    return found;
}

// The commands that change a worktree or a branch, in the order the program issued them.
function mutations(): string[] {
    return feature.git.commandLines().filter((line: string): boolean =>
        /^git (worktree (unlock|remove|prune)|branch -D|tag )/.test(line));
}

beforeEach(async (): Promise<void> => {
    primary = specTempDirs.make('agent-lock-repo-');
    worktrees = specTempDirs.make('agent-lock-trees-');
    // A primary clone as git lays it out on disk, so the mutation log lands in its `.webpieces/`.
    mkdirSync(join(primary, '.git', 'objects'), { recursive: true });
    writeFileSync(join(primary, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    world = new GitWorld(primary);
    feature = await WorkflowFeature.create();
    feature.git.respondToPrefix([], (call: ProcessCallDto): GitResultDto => world.git(call));
    feature.processes.respondToPrefix('gh', [], (call: ProcessCallDto): ProcessResultDto => world.gh(call));

    // An EMPTY harness state tree by default: "the harness knows nothing about that agent", which is
    // the honest default for a temp repo and exercises the fail-safe path.
    configDir = specTempDirs.make('agent-lock-claude-');
    subagents = join(configDir, 'projects', '-tmp-repo', 'session-1', 'subagents');
    mkdirSync(subagents, { recursive: true });
    originalConfigDir = process.env['CLAUDE_CONFIG_DIR'];
    process.env['CLAUDE_CONFIG_DIR'] = configDir;
});

afterEach((): void => {
    if (originalConfigDir === undefined) delete process.env['CLAUDE_CONFIG_DIR'];
    else process.env['CLAUDE_CONFIG_DIR'] = originalConfigDir;
    rmSync(primary, { recursive: true, force: true });
    rmSync(worktrees, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
});

describe('wp-cleanup verdicts for a locked worktree', (): void => {
    /**
     * THE BUG, pinned. Every worktree in a session records the SAME pid — the session process — so
     * `process.pid` here is exactly what the field sees, and it is ALIVE. The verdict must still be
     * deletable, and the reason must not claim anybody is working anywhere.
     */
    it('reaps a merged worktree whose agent has RETURNED, whatever the live pid in the lock says', async (): Promise<void> => {
        const treePath = addLockedWorktree('landed', MERGED_BRANCH, agentReason('agent-done'));
        writeAgentState('agent-done', treePath, 'text');

        const verdict = await verdictFor(treePath);

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
    it('reaps a merged worktree when the harness knows nothing about its agent', async (): Promise<void> => {
        const treePath = addLockedWorktree('landed', MERGED_BRANCH, agentReason('agent-unknown'));

        const verdict = await verdictFor(treePath);

        expect(verdict.deletable).toBe(true);
        expect(verdict.unlockBeforeRemove).toBe(true);
    });

    it('SPARES a merged worktree whose agent is still mid-tool-call', async (): Promise<void> => {
        const treePath = addLockedWorktree('landed', MERGED_BRANCH, agentReason('agent-live'));
        writeAgentState('agent-live', treePath, 'tool_use');

        const verdict = await verdictFor(treePath);

        expect(verdict.deletable).toBe(false);
        expect(verdict.unlockBeforeRemove).toBe(false);
        expect(verdict.reason).toContain('agent-live');
        expect(verdict.reason).toContain('working in here');
    });

    // The case the lock exists for. Uncommitted or untracked files are work no archive tag captures,
    // and nothing — not a merged PR, not a returned agent — overrides that.
    it('SPARES a merged worktree that has uncommitted work in it', async (): Promise<void> => {
        const treePath = addLockedWorktree('landed', MERGED_BRANCH, agentReason('agent-done'));
        writeAgentState('agent-done', treePath, 'text');
        leaveUncommittedWork(treePath);

        const verdict = await verdictFor(treePath);

        expect(verdict.deletable).toBe(false);
        expect(verdict.reason).toContain('uncommitted or untracked files');
        // The evidence came from `git status --porcelain` run IN that worktree.
        expect(feature.git.calls.some((call: ProcessCallDto): boolean =>
            call.commandLine === 'git status --porcelain' && call.cwd === treePath)).toBe(true);
    });

    /**
     * The asymmetry: a returned agent is not a licence to delete unmerged work, only to stop
     * pretending the lock protects it. And the message says only what is KNOWN — it replaced
     * "pid N still running — that agent is working in here", which was asserted as fact about seven
     * agents that had finished, several with merged PRs.
     */
    it('SPARES an unmerged worktree and does NOT claim anyone is working in it', async (): Promise<void> => {
        const treePath = addLockedWorktree('unmerged', LIVE_BRANCH, agentReason('agent-done'));
        writeAgentState('agent-done', treePath, 'text');

        const verdict = await verdictFor(treePath);

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
    it('SPARES an unrecognised lock reason, quoting it and attributing it to NOBODY', async (): Promise<void> => {
        const treePath = addLockedWorktree('debugging', MERGED_BRANCH, 'dean is debugging');

        const verdict = await verdictFor(treePath);

        expect(verdict.deletable).toBe(false);
        expect(verdict.unlockBeforeRemove).toBe(false);
        expect(verdict.reason).toContain('dean is debugging');
        expect(verdict.reason).not.toContain('human');
    });

    it('SPARES a lock with no reason at all, and says so rather than guessing', async (): Promise<void> => {
        const treePath = addLockedWorktree('bare', MERGED_BRANCH, null);

        const verdict = await verdictFor(treePath);

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
    it('judges a locked, unmerged worktree on its branch instead of hiding it behind the lock', async (): Promise<void> => {
        const treePath = addLockedWorktree('unmerged', LIVE_BRANCH, agentReason('agent-done'));
        writeAgentState('agent-done', treePath, 'text');

        const spared = await verdictFor(treePath);
        const judged = await verdictFor(treePath, true);

        expect(spared.classification).toBe('locked-worktree');
        expect(judged.classification).not.toBe('locked-worktree');
        expect(judged.unlockBeforeRemove).toBe(true);
        expect(judged.reason).toContain('treated as no evidence, as asked');
    });

    it('still spares a DIRTY worktree', async (): Promise<void> => {
        const treePath = addLockedWorktree('unmerged', LIVE_BRANCH, agentReason('agent-done'));
        writeAgentState('agent-done', treePath, 'text');
        leaveUncommittedWork(treePath);

        const verdict = await verdictFor(treePath, true);

        expect(verdict.deletable).toBe(false);
        expect(verdict.classification).toBe('locked-worktree');
        expect(verdict.reason).toContain('uncommitted or untracked files');
    });

    it('still spares a worktree whose agent is mid-tool-call', async (): Promise<void> => {
        const treePath = addLockedWorktree('unmerged', LIVE_BRANCH, agentReason('agent-live'));
        writeAgentState('agent-live', treePath, 'tool_use');

        const verdict = await verdictFor(treePath, true);

        expect(verdict.deletable).toBe(false);
        expect(verdict.classification).toBe('locked-worktree');
        expect(verdict.reason).toContain('working in here');
    });
});

describe('reaping a returned agent\'s merged worktree', (): void => {
    it('unlocks it, removes the directory and the branch, and logs the SHA and a recover= command', async (): Promise<void> => {
        const treePath = addLockedWorktree('landed', MERGED_BRANCH, agentReason('agent-done'));
        writeAgentState('agent-done', treePath, 'text');
        const tip = 'tip-of-landed';
        const verdict = await verdictFor(treePath);
        const reaper = feature.container.get(WorktreeReaper);

        const result = await reaper.reapWorktrees(primary, primary, 'wp-cleanup', [verdict]);

        expect(result.failed).toEqual([]);
        expect(result.reaped.length).toBe(1);
        expect(result.reaped[0].sha).toBe(tip);
        expect(result.reaped[0].branchDeleted).toBe(true);

        // Archived first, then the lock cleared, then the directory and the branch removed — in that order.
        const issued = mutations();
        expect(issued.length).toBe(4);
        expect(issued[0]).toMatch(new RegExp(`^git tag archive/\\d{4}-\\d{2}-\\d{2}/${MERGED_BRANCH} ${tip}$`));
        expect(issued.slice(1)).toEqual([
            `git worktree unlock ${treePath}`,
            `git worktree remove ${treePath}`,
            `git branch -D ${MERGED_BRANCH}`,
        ]);

        // Every removal stays recoverable — that guarantee is unchanged by the unlock.
        const restore = reaper.restoreCommand(result.reaped[0]);
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
    it('does NOT unlock a worktree whose verdict never asked for it', async (): Promise<void> => {
        const treePath = addLockedWorktree('landed', MERGED_BRANCH, 'dean is debugging');
        const forced = new DeletableWorktree(
            treePath, MERGED_BRANCH, `PR #${String(MERGED_PR)} merged`, MERGED_PR, true, 'merged-pr');

        const result = await feature.container.get(WorktreeReaper).reapWorktrees(primary, primary, 'wp-cleanup', [forced]);

        expect(result.reaped).toEqual([]);
        expect(result.failed.length).toBe(1);
        expect(result.failed[0].error).toContain('locked');
        expect(mutations().some((line: string): boolean => line.startsWith('git worktree unlock'))).toBe(false);
        expect(mutations().some((line: string): boolean => line.startsWith('git branch -D'))).toBe(false);
    });
});

// The reaper's own rails are unrelated to locking and must not have moved.
describe('the standing-in-it rail is untouched', (): void => {
    it('refuses to reap the worktree the command is running in, lock or no lock', async (): Promise<void> => {
        const treePath = addLockedWorktree('landed', MERGED_BRANCH, agentReason('agent-done'));
        writeAgentState('agent-done', treePath, 'text');
        const verdict = await verdictFor(treePath);

        const result = await feature.container.get(WorktreeReaper).reapWorktrees(primary, treePath, 'wp-cleanup', [verdict]);

        expect(result.reaped).toEqual([]);
        expect(result.spared.length).toBe(1);
        expect(result.spared[0].reason).toContain('self-destruct');
        expect(mutations()).toEqual([]);
    });
});
