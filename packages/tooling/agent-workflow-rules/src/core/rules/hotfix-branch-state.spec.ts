import { describe, it, expect, beforeEach, vi } from 'vitest';

import { MainSyncStatus } from '@webpieces/repo-workflow-core';
import { BranchStateGuardConfig } from '../../configs/main-sync-guard-configs';

import { BashContext } from '@webpieces/hook-runtime';
import type { FileContext } from '@webpieces/hook-runtime';

type RepoWorkflowCoreModule = typeof import('@webpieces/repo-workflow-core');

/**
 * Issue #1371 — L2 row 14. A `/hotfix/` branch is cut from the PRODUCTION sha, so `origin/main` is always
 * ahead of it and must never be merged in. Every L2 block that can fire on a non-`main` branch — the
 * collision and no-fork-point rows (9) and the merged-branch row (8) — prescribes merging main or
 * branching off it, so on a hotfix branch the Write, Read and Bash halves all stand down, logged
 * `ALLOW_EXEMPT` against row 14's reason.
 *
 * The CONTROL cases are the point as much as the exemption: the predicate is BranchIdentity's ONE exact,
 * case-sensitive `/hotfix/` SEGMENT, so `feature/hotfix-thing` and `x/HotFix/y` keep every guard.
 */

const HOTFIX = 'prod/dean/hotfix/2026-10-22/ONE-3461-test-log-line';
const NOT_HOTFIX: readonly string[] = ['feature/hotfix-thing', 'x/HotFix/y', 'dean/hotfix'];
const HOTFIX_REASON = 'hotfix-branch (cut from production; main is never merged in)';

const state = vi.hoisted(() => ({
    branch: 'dean/x',
    status: null as MainSyncStatus | null,
    decisions: [] as unknown[][],
}));

vi.mock('child_process', () => ({
    execSync: (): string => `${state.branch}\n`,
    // `/tmp/x` is fictional, so git's honest answer for it is "not a repo".
    spawnSync: (): { status: number; stdout: string } => ({ status: 1, stdout: '' }),
}));

vi.mock('@webpieces/tooling-common', async (importOriginal: () => Promise<typeof import('@webpieces/tooling-common')>) => {
    const actual = await importOriginal();
    class DictatedCheckout extends actual.GitCheckout {
        override branch(): string | null {
            return state.branch;
        }
    }
    return { ...actual, gitCheckout: new DictatedCheckout() };
});

vi.mock('@webpieces/repo-workflow-core', async (importActual: () => Promise<RepoWorkflowCoreModule>) => {
    const actual = await importActual();
    return { ...actual, readMainSyncStatus: (): MainSyncStatus | null => state.status };
});

vi.mock('../main-sync-refresh', () => ({ triggerMainSyncRefresh: (): void => undefined }));

// Captures every decision line, so the exemption is proven to be LOGGED as one — not merely to return [].
vi.mock('../decision-log', () => ({
    logGuardDecision: (_root: string, decision: { args: unknown[] }): void => {
        state.decisions.push(decision.args);
    },
    GuardDecision: class {
        readonly args: unknown[];
        constructor(...args: unknown[]) {
            this.args = args;
        }
    },
    matrixL2Row: (reason: string) => ({ layer: 'L2', row: reason }),
}));

import { FeatureBranchGuardRule } from './feature-branch-guard';
import { ReadStaleGuardRule } from './read-stale-guard';
import { MergedBranchBashGuardRule } from './merged-branch-bash-guard';

function config(): BranchStateGuardConfig {
    const cfg = new BranchStateGuardConfig();
    cfg.mode = 'ON';
    cfg.maxCommitsBehind = 5;
    return cfg;
}

function fileCtx(tool: string): FileContext {
    return { relativePath: 'src/a.ts', filePath: '/tmp/x/src/a.ts', workspaceRoot: '/tmp/x', tool, options: {} } as FileContext;
}

/** A cache entry for the checked-out branch, in the state named by `over`. */
function status(over: Partial<MainSyncStatus>): MainSyncStatus {
    const base = new MainSyncStatus(state.branch, false, '', true, 'fork', 'main', 'head', false, [], 'ts');
    return Object.assign(base, over);
}

const MAIN_MOVED: Partial<MainSyncStatus> = { conflict: true, conflictFiles: ['services/ai-chat/src/index.ts'] };
const NO_FORK: Partial<MainSyncStatus> = { hasForkPoint: false, forkPoint: null };
const MERGED: Partial<MainSyncStatus> = { branchAlreadyMerged: true, mergedPr: '207' };

/** The verdict and reason fields of the last decision line (GuardDecision's 5th and 6th arguments). */
function lastVerdict(): readonly unknown[] {
    const last = state.decisions[state.decisions.length - 1] ?? [];
    return [last[4], last[5]];
}

beforeEach(() => {
    state.decisions = [];
    state.status = null;
});

describe('feature-branch-guard (Write/Edit) on a /hotfix/ branch — L2 row 14', () => {
    for (const [name, over] of [['main moved and collided (issue #1371)', MAIN_MOVED], ['no fork point', NO_FORK], ['already merged', MERGED]] as const) {
        it(`never demands main on a hotfix branch: ${name}`, () => {
            state.branch = HOTFIX;
            state.status = status(over);
            expect(new FeatureBranchGuardRule(config()).check(fileCtx('Edit'))).toEqual([]);
            expect(lastVerdict()).toEqual(['ALLOW_EXEMPT', HOTFIX_REASON]);
        });

        for (const branch of NOT_HOTFIX) {
            it(`CONTROL — still blocks '${branch}': ${name}`, () => {
                state.branch = branch;
                state.status = status(over);
                expect(new FeatureBranchGuardRule(config()).check(fileCtx('Edit'))).toHaveLength(1);
            });
        }
    }

    it('names the colliding files on a feature branch, exactly as before', () => {
        state.branch = 'feature/hotfix-thing';
        state.status = status(MAIN_MOVED);
        const violations = new FeatureBranchGuardRule(config()).check(fileCtx('Edit'));
        expect(violations[0].message).toContain('You must merge main in before editing further');
    });

    it('is exempt even before the first refresh has written a cache', () => {
        state.branch = HOTFIX;
        expect(new FeatureBranchGuardRule(config()).check(fileCtx('Write'))).toEqual([]);
        expect(lastVerdict()).toEqual(['ALLOW_EXEMPT', HOTFIX_REASON]);
    });
});

describe('read-stale-guard (Read) on a /hotfix/ branch — L2 row 14', () => {
    it('never blocks a read on a merged hotfix branch', () => {
        state.branch = HOTFIX;
        state.status = status(MERGED);
        expect(new ReadStaleGuardRule(config()).check(fileCtx('Read'))).toEqual([]);
        expect(lastVerdict()).toEqual(['ALLOW_EXEMPT', HOTFIX_REASON]);
    });

    for (const branch of NOT_HOTFIX) {
        it(`CONTROL — still blocks a read on merged '${branch}'`, () => {
            state.branch = branch;
            state.status = status(MERGED);
            expect(new ReadStaleGuardRule(config()).check(fileCtx('Read'))).toHaveLength(1);
        });
    }
});

describe('merged-branch-bash-guard (Bash) on a /hotfix/ branch — L2 row 14', () => {
    it('never blocks a command on a merged hotfix branch', () => {
        state.branch = HOTFIX;
        state.status = status(MERGED);
        expect(new MergedBranchBashGuardRule(config()).check(new BashContext('pnpm build', '/tmp/x'))).toEqual([]);
        expect(lastVerdict()).toEqual(['ALLOW_EXEMPT', HOTFIX_REASON]);
    });

    for (const branch of NOT_HOTFIX) {
        it(`CONTROL — still blocks a command on merged '${branch}'`, () => {
            state.branch = branch;
            state.status = status(MERGED);
            expect(new MergedBranchBashGuardRule(config()).check(new BashContext('pnpm build', '/tmp/x'))).toHaveLength(1);
        });
    }
});
