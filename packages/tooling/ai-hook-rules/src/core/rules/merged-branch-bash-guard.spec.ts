import { describe, it, expect, beforeEach, vi } from 'vitest';

import { MainSyncStatus, MergedBranchBashGuardConfig } from '@webpieces/rules-config';

import { BashContext } from '../types';

type RulesConfigModule = typeof import('@webpieces/rules-config');

// Mutable state the mocks read. vi.hoisted so the vi.mock factories can close over it.
//   branch       — what `git rev-parse --abbrev-ref HEAD` reports
//   status       — the cached main-sync-status.json the guard reads
//   branchThrows — simulate git being unavailable entirely (fail-open)
const state = vi.hoisted(() => ({
    branch: 'feature-x',
    status: null as MainSyncStatus | null,
    branchThrows: false,
}));

vi.mock('child_process', () => ({
    execSync: (cmd: string): string => {
        if (cmd.includes('--abbrev-ref')) {
            if (state.branchThrows) throw new Error('not a git repository');
            return `${state.branch}\n`;
        }
        return '';
    },
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

import { MergedBranchBashGuardRule } from './merged-branch-bash-guard';

function ctx(command: string): BashContext {
    return new BashContext(command, '/tmp/x');
}

function rule(): MergedBranchBashGuardRule {
    const cfg = new MergedBranchBashGuardConfig();
    cfg.mode = 'ON';
    return new MergedBranchBashGuardRule(cfg);
}

// A cache for the checked-out branch. `merged` toggles branchAlreadyMerged (+ a PR number).
function status(over: Partial<MainSyncStatus> = {}): MainSyncStatus {
    const base = new MainSyncStatus('feature-x', true, '194', true, 'fork', 'origin-sha', 'head', false, [], 'ts');
    return Object.assign(base, over);
}

// Baseline: on a merged feature branch with a matching cache — the blocking case. Each test perturbs
// one axis.
function reset(): void {
    state.branch = 'feature-x';
    state.status = status();
    state.branchThrows = false;
}

function allowed(command: string): boolean {
    return rule().check(ctx(command)).length === 0;
}

describe('merged-branch-bash-guard — blocks non-recovery bash on a merged branch', () => {
    beforeEach(reset);

    it('blocks booting servers, reading repo files, builds, and git writes', () => {
        expect(allowed('scripts/local.sh start lang')).toBe(false);
        expect(allowed('cat src/foo.ts')).toBe(false);
        expect(allowed('ls services/lang')).toBe(false);
        expect(allowed('pnpm build')).toBe(false);
        expect(allowed('pnpm nx run-many -t test')).toBe(false);
        expect(allowed('git commit -m "keep working"')).toBe(false);
        expect(allowed('git push')).toBe(false);
    });

    it('the block message names the already-merged state and the cure', () => {
        const violations = rule().check(ctx('scripts/local.sh start lang'));
        expect(violations.length).toBe(1);
        expect(violations[0].message).toContain('already merged');
        expect(violations[0].message).toContain('origin/main');
    });

    it('denies a chain if ANY segment is non-recovery, even when the rest is allowlisted', () => {
        expect(allowed('git status && cat src/foo.ts')).toBe(false);
        expect(allowed('git fetch origin main && scripts/local.sh start')).toBe(false);
    });
});

describe('merged-branch-bash-guard — allows recovery / cleanup / inspection', () => {
    beforeEach(reset);

    it('allows the fresh-start cure and switching away', () => {
        expect(allowed('git fetch origin main && git checkout -b dean/new origin/main')).toBe(true);
        expect(allowed('git worktree add ../new -b dean/new origin/main')).toBe(true);
        expect(allowed('git checkout main && git pull origin main')).toBe(true);
        expect(allowed('git switch some-other-branch')).toBe(true);
        expect(allowed('git worktree prune && git worktree remove ../dead && git branch -D dead')).toBe(true);
    });

    it('allows read-only git/gh orientation', () => {
        expect(allowed('git status')).toBe(true);
        expect(allowed('git log --oneline -20')).toBe(true);
        expect(allowed('git diff HEAD~1')).toBe(true);
        expect(allowed('git branch -a')).toBe(true);
        expect(allowed('gh pr list --state merged')).toBe(true);
        expect(allowed('gh pr view 194')).toBe(true);
    });

    it('allows the wp-* cleanup bins and installs, but not other pnpm scripts', () => {
        expect(allowed('pnpm wp-cleanup')).toBe(true);
        expect(allowed('pnpm install')).toBe(true);
        expect(allowed('pnpm test')).toBe(false);
    });

    it('does NOT allowlist gh writes (governed by the PR guards)', () => {
        expect(allowed('gh pr create --title x')).toBe(false);
        expect(allowed('gh pr merge 194')).toBe(false);
    });
});

describe('merged-branch-bash-guard — fail-open', () => {
    beforeEach(reset);

    it('allows everything when the branch is NOT merged', () => {
        state.status = status({ branchAlreadyMerged: false, mergedPr: '' });
        expect(allowed('scripts/local.sh start lang')).toBe(true);
        expect(allowed('cat src/foo.ts')).toBe(true);
    });

    it('allows when the cache is for a DIFFERENT branch (never act on another branch snapshot)', () => {
        state.status = status({ branch: 'some-old-branch' });
        expect(allowed('scripts/local.sh start lang')).toBe(true);
    });

    it('allows when there is no cache yet', () => {
        state.status = null;
        expect(allowed('scripts/local.sh start lang')).toBe(true);
    });

    it('allows when the branch cannot be determined', () => {
        state.branchThrows = true;
        expect(allowed('scripts/local.sh start lang')).toBe(true);
    });
});
