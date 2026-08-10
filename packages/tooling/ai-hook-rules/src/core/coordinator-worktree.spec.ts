import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as nodePath from 'path';

import { migrate } from '../bin/setup';
import { AgentIdentity, CoordinatorWorktreeGuard, UNKNOWN_AGENT } from './coordinator-worktree';
import { EffectiveTreeResolver } from './effective-tree';
import { runBash } from './runner';
import { BlockedResult } from './types';

/**
 * The incident these lock down: the coordinator `git worktree add`s a tree, `cd`s in, and works there.
 * Its governance stays anchored to the primary clone (fixed at session start, never follows a `cd`),
 * so every fault it is shown is measured against a tree it is not standing in — and every cure it runs
 * lands in a tree nothing measures. Five no-op `pnpm install`s and a fabricated theory about the
 * harness later, the human had to untangle it.
 *
 * A subagent bound to the worktree has both in ONE tree, which is why the same commands must keep
 * working for one and stop working for the other.
 */

function gitIn(cwd: string, ...args: string[]): void {
    execFileSync('git', args, { cwd, stdio: 'pipe' });
}

function initRepo(dir: string): void {
    fs.mkdirSync(dir, { recursive: true });
    gitIn(dir, 'init', '-b', 'main');
    // Temp repos must not run this machine's global hooks — a pre-push/pre-commit hook that forbids
    // main would fail the fixture, not the code under test.
    gitIn(dir, 'config', 'core.hooksPath', '/dev/null');
    gitIn(dir, 'config', 'user.email', 'test@example.com');
    gitIn(dir, 'config', 'user.name', 'test');
    fs.writeFileSync(nodePath.join(dir, 'f.txt'), 'x');
    gitIn(dir, 'add', '-A');
    gitIn(dir, 'commit', '-m', 'init');
}

// Every guard OFF: this block is structural (L1), so it must fire with no rule armed at all — and
// nothing else may fire and steal the verdict.
function writeAllGuardsOffConfig(root: string): void {
    // webpieces-disable no-any-unknown -- opaque JSON config shape, only mutated by known keys here
    const config = migrate({}).config as Record<string, any>;
    config.hookGuards['branch-creation-guard'].autoReapMergedBranches = false;
    for (const name of Object.keys(config.hookGuards)) {
        config.hookGuards[name].mode = 'OFF';
    }
    config.excludePaths = [];
    fs.writeFileSync(nodePath.join(root, 'webpieces.config.json'), JSON.stringify(config));
}

const COORDINATOR = new AgentIdentity('', '');
const SUBAGENT = new AgentIdentity('agent-a3e4f752', 'general-purpose');

let primary: string;
let worktree: string;
let agentWorktree: string;
let nestedClone: string;
let outside: string;

beforeAll(() => {
    // realpathSync so paths match `git rev-parse --show-toplevel` (macOS /var → /private/var).
    const home = fs.realpathSync(fs.mkdtempSync(nodePath.join(os.tmpdir(), 'wp-coord-')));
    primary = nodePath.join(home, 'primary');
    initRepo(primary);
    writeAllGuardsOffConfig(primary);
    worktree = nodePath.join(home, 'wt-feature');
    gitIn(primary, 'worktree', 'add', worktree, '-b', 'feature-x');
    // The layout the Claude Code harness actually creates — INSIDE the governed root.
    agentWorktree = nodePath.join(primary, '.claude', 'worktrees', 'agent-a9d8eab30bdce959d');
    gitIn(primary, 'worktree', 'add', agentWorktree, '-b', 'agent-branch');
    nestedClone = nodePath.join(primary, 'repositories', 'clone');
    initRepo(nestedClone);
    outside = nodePath.join(home, 'scratch');
    fs.mkdirSync(outside, { recursive: true });
});

function treeFor(command: string): ReturnType<EffectiveTreeResolver['resolve']> {
    return new EffectiveTreeResolver().resolve(command, primary, primary);
}

function blockFor(command: string, agent: AgentIdentity): string | null {
    return new CoordinatorWorktreeGuard().block(command, treeFor(command), agent);
}

describe('CoordinatorWorktreeGuard — the predicate', () => {
    it('coordinator + worktree + a mutating command → BLOCK', () => {
        expect(blockFor(`cd ${worktree} && rm -rf dist`, COORDINATOR)).not.toBeNull();
    });

    it('the exact incident shape: `cd <worktree> && pnpm build` typed from the PRIMARY blocks', () => {
        // shellCwd is the primary clone — the harness reset it — and only the command's own leading
        // `cd` says otherwise. Judging the raw cwd would have allowed this, which is the whole bug.
        const command = `cd ${worktree} && pnpm build`;
        expect(treeFor(command).shellCwd).toBe(primary);
        expect(blockFor(command, COORDINATOR)).not.toBeNull();
    });

    it('a SUBAGENT in the same worktree is ALLOWED — that is the prescribed pattern', () => {
        expect(blockFor(`cd ${worktree} && pnpm build`, SUBAGENT)).toBeNull();
    });

    it('coordinator in the PRIMARY clone is ALLOWED', () => {
        expect(blockFor('pnpm build', COORDINATOR)).toBeNull();
    });

    it('coordinator inspecting a worktree with `git -C` is ALLOWED — no `cd`, so the tree is primary', () => {
        const command = `git -C ${worktree} status`;
        expect(treeFor(command).kind).toBe('primary');
        expect(blockFor(command, COORDINATOR)).toBeNull();
    });

    it('read-only orientation inside the worktree is ALLOWED — you must be able to look before you delegate', () => {
        expect(blockFor(`cd ${worktree} && ls -la`, COORDINATOR)).toBeNull();
        expect(blockFor(`cd ${worktree} && cat package.json`, COORDINATOR)).toBeNull();
        expect(blockFor(`cd ${worktree} && grep -rn TODO src`, COORDINATOR)).toBeNull();
    });

    it('a redirect makes an "inspection" a writer, so it blocks again', () => {
        expect(blockFor(`cd ${worktree} && cat a.txt > b.txt`, COORDINATOR)).not.toBeNull();
    });

    it("foreign and outside are NOT this guard's job — their classification is left alone", () => {
        expect(treeFor(`cd ${nestedClone} && pnpm build`).kind).toBe('foreign');
        expect(blockFor(`cd ${nestedClone} && pnpm build`, COORDINATOR)).toBeNull();
        expect(treeFor(`cd ${outside} && pnpm build`).kind).toBe('outside');
        expect(blockFor(`cd ${outside} && pnpm build`, COORDINATOR)).toBeNull();
    });

    it('a QUOTED cd cannot trigger it — prose about a worktree is not work in one', () => {
        expect(blockFor(`echo "cd ${worktree} && pnpm build"`, COORDINATOR)).toBeNull();
    });

    /**
     * This guard was DEAD CODE for the only worktree layout the harness actually produces. Claude Code
     * creates agent worktrees at `<repo>/.claude/worktrees/agent-XXXX` — inside the governed root —
     * which classify() called `foreign`, and this guard requires `kind === 'worktree'`. Measured: the
     * coordinator ran `cd <that worktree> && git status` and no guard fired at all.
     */
    it('the IN-REPO agent worktree blocks the coordinator too — it was unreachable here before', () => {
        expect(treeFor(`cd ${agentWorktree} && pnpm build`).kind).toBe('worktree');
        expect(blockFor(`cd ${agentWorktree} && pnpm build`, COORDINATOR)).not.toBeNull();
    });

    it('a SUBAGENT in the in-repo agent worktree is still ALLOWED — that is the whole point of them', () => {
        expect(blockFor(`cd ${agentWorktree} && pnpm build`, SUBAGENT)).toBeNull();
    });
});

describe('AgentIdentity — absence of the payload fields IS the coordinator signal', () => {
    it('both fields empty → coordinator', () => {
        expect(new AgentIdentity('', '').coordinator).toBe(true);
    });

    it('either field populated → a subagent', () => {
        expect(new AgentIdentity('abc', 'Explore').coordinator).toBe(false);
        expect(new AgentIdentity('abc', '').coordinator).toBe(false);
    });

    it('UNKNOWN_AGENT is NOT the coordinator — a caller that cannot tell must not be guessed into a block', () => {
        expect(UNKNOWN_AGENT.coordinator).toBe(false);
    });
});

describe('the deny message', () => {
    const report = (): string => blockFor(`cd ${worktree} && pnpm build`, COORDINATOR) ?? '';

    it('names the worktree it would have worked in, and the root that governs instead', () => {
        expect(report()).toContain(worktree);
        expect(report()).toContain(primary);
    });

    it('prescribes spawning a subagent bound to that worktree', () => {
        expect(report()).toContain('Spawn a subagent bound to that worktree');
        expect(report()).toContain('EnterWorktree');
    });

    it('lists the read-only escapes, so inspection is never mistaken for forbidden', () => {
        expect(report()).toContain('Read tool');
        expect(report()).toContain(`git -C ${worktree}`);
    });

    it('stays on the L0 message diet — short enough to be read, not skimmed past', () => {
        expect(report().split('\n').length).toBeLessThanOrEqual(12);
    });
});

describe('runBash end-to-end', () => {
    it('blocks the coordinator working in the worktree, with every rule OFF (this is structural)', () => {
        const result = runBash(`cd ${worktree} && pnpm build`, primary, 'guards', COORDINATOR);
        expect(result).toBeInstanceOf(BlockedResult);
        expect((result as BlockedResult).report).toContain('COORDINATOR');
    });

    it('lets the same command through for a subagent', () => {
        expect(runBash(`cd ${worktree} && pnpm build`, primary, 'guards', SUBAGENT)).toBeNull();
    });

    it('defaults to UNKNOWN_AGENT when no identity is supplied — existing callers are unaffected', () => {
        expect(runBash(`cd ${worktree} && pnpm build`, primary, 'guards')).toBeNull();
    });

    it('the L0 cure bypass still wins: `cd <worktree> && pnpm install` is allowed even for the coordinator', () => {
        // A cure must stay reachable from ANY tree. This is the literal command from the incident, and
        // it is deliberately NOT what this guard removes — what it removes is the session shape that
        // made running it in the wrong tree plausible.
        expect(runBash(`cd ${worktree} && pnpm install`, primary, 'guards', COORDINATOR)).toBeNull();
    });
});
