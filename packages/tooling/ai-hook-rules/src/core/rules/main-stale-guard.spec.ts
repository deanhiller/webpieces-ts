import { describe, it, expect, beforeEach, vi } from 'vitest';

import { MainSyncStatus, MainStaleGuardConfig } from '@webpieces/rules-config';

import type { FileContext } from '../types';

type RulesConfigModule = typeof import('@webpieces/rules-config');

// Mutable state the mocks read. vi.hoisted so the vi.mock factories can close over it.
//   branch      — what `git rev-parse --abbrev-ref HEAD` reports
//   status      — the cached main-sync-status.json the guard reads
//   porcelain   — `git status --porcelain` output ('' = clean tree)
//   ancestorRc  — exit code of `git merge-base --is-ancestor <originMain> HEAD`
//                 0 = local main already contains cached origin/main (up to date)
//                 1 = cleanly behind
//                 128 = git could not answer (bad object) → must fail OPEN
//   branchThrows — simulate git being unavailable entirely
//   gitHead     — contents of .git/HEAD, or null to make the fast path unavailable (fall back to git)
//   gitIsDir    — false simulates a worktree, where .git is a FILE and HEAD lives elsewhere
//   execBranchCalls — counts spawns of `git rev-parse --abbrev-ref`, to prove the fast path avoids them
const state = vi.hoisted(() => ({
    branch: 'main',
    status: null as MainSyncStatus | null,
    porcelain: '',
    ancestorRc: 1,
    branchThrows: false,
    gitHead: null as string | null,
    gitIsDir: true,
    execBranchCalls: 0,
}));

vi.mock('fs', () => ({
    statSync: (): { isDirectory: () => boolean } => {
        if (state.gitHead === null) throw new Error('ENOENT');
        return { isDirectory: (): boolean => state.gitIsDir };
    },
    readFileSync: (): string => {
        if (state.gitHead === null) throw new Error('ENOENT');
        return state.gitHead;
    },
}));

vi.mock('child_process', () => ({
    execSync: (cmd: string): string => {
        if (cmd.includes('--abbrev-ref')) {
            state.execBranchCalls += 1;
            if (state.branchThrows) throw new Error('not a git repository');
            return `${state.branch}\n`;
        }
        if (cmd.includes('status --porcelain')) return state.porcelain;
        if (cmd.includes('rev-list')) return '3\n';
        return '';
    },
    spawnSync: (): { status: number } => ({ status: state.ancestorRc }),
}));

vi.mock('@webpieces/rules-config', async (importActual: () => Promise<RulesConfigModule>) => {
    const actual = await importActual();
    return {
        ...actual,
        readMainSyncStatus: (): MainSyncStatus | null => state.status,
    };
});

// Spawning the detached refresher must never run in tests.
vi.mock('../main-sync-refresh', () => ({ triggerMainSyncRefresh: (): void => undefined }));
// The decision log writes to disk; silence it so tests never touch the fs.
vi.mock('../decision-log', () => ({
    logGuardDecision: (): void => undefined,
    GuardDecision: class { constructor(...args: unknown[]) { void args; } },
}));

import { MainStaleGuardRule } from './main-stale-guard';

function ctx(relativePath: string = 'src/a.ts'): FileContext {
    return { relativePath, workspaceRoot: '/tmp/x', tool: 'Read', options: {} } as FileContext;
}

function rule(): MainStaleGuardRule {
    const cfg = new MainStaleGuardConfig();
    cfg.mode = 'ON';
    return new MainStaleGuardRule(cfg);
}

// A cache that says "on main, and origin/main is some commit". Behind-ness is decided by ancestorRc,
// never by comparing these strings — that is the whole point of escape valve 2.
function status(over: Partial<MainSyncStatus> = {}): MainSyncStatus {
    const base = new MainSyncStatus('main', false, '', true, 'fork', 'origin-sha', 'head', false, [], 'ts');
    base.localMain = 'local-sha';
    return Object.assign(base, over);
}

// Baseline: on main, clean tree, cache present, local main genuinely behind → the blocking case.
// Each describe below installs this and then perturbs exactly one axis.
function reset(): void {
    state.branch = 'main';
    state.status = status();
    state.porcelain = '';
    state.ancestorRc = 1;
    state.branchThrows = false;
    state.gitHead = null;
    state.gitIsDir = true;
    state.execBranchCalls = 0;
}

// ---- the per-read cost path ---------------------------------------------------------------------
// This runs on EVERY read, so it must not spawn a git process on the common (feature-branch) case.
describe('main-stale-guard — branch detection cost', () => {
    beforeEach(reset);

    describe('branch detection cost', () => {
        it('reads .git/HEAD instead of spawning git, on the common feature-branch path', () => {
            state.gitHead = 'ref: refs/heads/dean/x\n';
            expect(rule().check(ctx()).length).toBe(0);
            expect(state.execBranchCalls).toBe(0);
        });

        it('still blocks correctly when .git/HEAD says main', () => {
            state.gitHead = 'ref: refs/heads/main\n';
            expect(rule().check(ctx()).length).toBe(1);
            expect(state.execBranchCalls).toBe(0);
        });

        it('falls back to spawning git in a worktree (.git is a file, HEAD lives elsewhere)', () => {
            state.gitHead = 'gitdir: /elsewhere/.git/worktrees/wt\n';
            state.gitIsDir = false;
            state.branch = 'dean/x';
            expect(rule().check(ctx()).length).toBe(0);
            expect(state.execBranchCalls).toBe(1);
        });

        it('falls back to spawning git on a detached HEAD (raw sha, no ref: line)', () => {
            state.gitHead = 'a8b1b91ea4b117cc05e15364108c094b16e3a1c9\n';
            state.branch = 'dean/x';
            expect(rule().check(ctx()).length).toBe(0);
            expect(state.execBranchCalls).toBe(1);
        });
    });
});

// ---- the one case that blocks -------------------------------------------------------------------
describe('main-stale-guard — blocking', () => {
    beforeEach(reset);

    it('blocks a read on a clean main that is behind origin/main', () => {
        const violations = rule().check(ctx());
        expect(violations.length).toBe(1);
        expect(violations[0].message).toContain('git pull origin main');
    });

    it('names what is still allowed in the block message, so the agent is never stuck', () => {
        const message = rule().check(ctx())[0].message ?? '';
        expect(message).toContain('EVERY Bash command');
        expect(message).toContain('webpieces.config.json');
    });

    it('reports how far behind main is', () => {
        expect(rule().check(ctx())[0].message).toContain('3 commit(s) behind');
    });

});

// ---- the fail-open escape valves (D1-D12) -------------------------------------------------------
// Every row here is a deadlock this guard would otherwise create. They all resolve to ALLOW.
describe('main-stale-guard — fail-open escape valves', () => {
    beforeEach(reset);

    // ---- D1/D8: scope --------------------------------------------------------------------------
    it('allows when not on main (feature-branch-guard owns that case)', () => {
        state.branch = 'dean/x';
        expect(rule().check(ctx()).length).toBe(0);
    });

    it('allows files outside the workspace', () => {
        expect(rule().check(ctx('../outside.ts')).length).toBe(0);
    });

    // ---- D2: dirty tree ------------------------------------------------------------------------
    it('allows when the tree is dirty — a pull is not a clean fast-forward and the agent must be able to read', () => {
        state.porcelain = ' M src/a.ts\n';
        expect(rule().check(ctx()).length).toBe(0);
    });

    // ---- D3: cache lag, the anti-spin guarantee ------------------------------------------------
    it('allows the instant local main CONTAINS the cached origin/main, without waiting for a cache refresh', () => {
        // Hashes still differ (localMain 'local-sha' !== originMain 'origin-sha') — an equality check
        // would keep blocking here and spin the agent forever. Ancestry says we are current.
        state.ancestorRc = 0;
        expect(rule().check(ctx()).length).toBe(0);
    });

    it('fails open when git cannot answer the ancestry question (pruned/bad object)', () => {
        state.ancestorRc = 128;
        expect(rule().check(ctx()).length).toBe(0);
    });

    // ---- D9: the escape hatch ------------------------------------------------------------------
    it('always allows reading webpieces.config.json so mode OFF stays reachable', () => {
        expect(rule().check(ctx('webpieces.config.json')).length).toBe(0);
    });

    // ---- D4/D5/D7/D12: no data -----------------------------------------------------------------
    it('fails open when there is no cache yet', () => {
        state.status = null;
        expect(rule().check(ctx()).length).toBe(0);
    });

    it('fails open when the cache is for a different branch', () => {
        state.status = status({ branch: 'dean/x' });
        expect(rule().check(ctx()).length).toBe(0);
    });

    it('fails open when origin/main is unknown (offline)', () => {
        state.status = status({ originMain: '' });
        expect(rule().check(ctx()).length).toBe(0);
    });

    it('fails open when the branch cannot be determined (not a git repo)', () => {
        state.branchThrows = true;
        expect(rule().check(ctx()).length).toBe(0);
    });

});

// ---- config -------------------------------------------------------------------------------------
describe('main-stale-guard — config', () => {
    beforeEach(reset);

    it('does not run when mode is OFF', () => {
        const cfg = new MainStaleGuardConfig();
        cfg.mode = 'OFF';
        expect(new MainStaleGuardRule(cfg).shouldRun()).toBe(false);
    });
});
