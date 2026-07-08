import { describe, it, expect, beforeEach, vi } from 'vitest';

import { MainSyncStatus, FeatureBranchGuardConfig } from '@webpieces/rules-config';

import type { FileContext } from '../types';

type RulesConfigModule = typeof import('@webpieces/rules-config');

// Mutable state the mocks read. vi.hoisted so the vi.mock factories can close over it.
const state = vi.hoisted(() => ({ branch: 'dean/x', status: null as MainSyncStatus | null }));

vi.mock('child_process', () => ({
    execSync: (): string => `${state.branch}\n`,
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

import { FeatureBranchGuardRule } from './feature-branch-guard';

function ctx(relativePath: string = 'src/a.ts'): FileContext {
    return { relativePath, workspaceRoot: '/tmp/x', options: {} } as FileContext;
}

function rule(): FeatureBranchGuardRule {
    const cfg = new FeatureBranchGuardConfig();
    cfg.mode = 'ON';
    return new FeatureBranchGuardRule(cfg);
}

function status(over: Partial<MainSyncStatus>): MainSyncStatus {
    const base = new MainSyncStatus('dean/x', false, '', true, 'fork', 'main', 'head', false, [], 'ts');
    return Object.assign(base, over);
}

describe('feature-branch-guard', () => {
    beforeEach(() => {
        state.branch = 'dean/x';
        state.status = null;
    });

    it('allows files outside the workspace', () => {
        expect(rule().check(ctx('../outside.ts')).length).toBe(0);
    });

    it('blocks on main (synchronous, no cache needed)', () => {
        state.branch = 'main';
        const violations = rule().check(ctx());
        expect(violations.length).toBe(1);
        expect(violations[0].message).toContain('should not be working on main');
    });

    it('allows when no cache exists yet (fail-open)', () => {
        state.status = null;
        expect(rule().check(ctx()).length).toBe(0);
    });

    it('allows when on a healthy, in-sync feature branch', () => {
        state.status = status({ hasForkPoint: true, conflict: false, branchAlreadyMerged: false });
        expect(rule().check(ctx()).length).toBe(0);
    });

    it('blocks when the branch was already merged (start fresh)', () => {
        state.status = status({ branchAlreadyMerged: true, mergedPr: '207' });
        const violations = rule().check(ctx());
        expect(violations.length).toBe(1);
        expect(violations[0].message).toContain('already merged');
        expect(violations[0].message).toContain('#207');
    });

    it('blocks with squash-recovery steps when there is no fork point', () => {
        state.status = status({ hasForkPoint: false, forkPoint: null });
        const violations = rule().check(ctx());
        expect(violations.length).toBe(1);
        expect(violations[0].message).toContain('No fork point');
        expect(violations[0].message).toContain('dean/x-v2');
    });

    it('fails open when the cache is for a DIFFERENT branch (stale cross-branch)', () => {
        // Cache was written for another branch (e.g. just switched branches); even though it says
        // merged+conflict, the guard must NOT block this branch on another branch's signals.
        state.branch = 'dean/current';
        state.status = status({ branch: 'dean/other', branchAlreadyMerged: true, mergedPr: '1', conflict: true, conflictFiles: ['x'] });
        expect(rule().check(ctx()).length).toBe(0);
    });

    it('already-merged takes priority over conflict', () => {
        state.status = status({ branchAlreadyMerged: true, mergedPr: '9', conflict: true, conflictFiles: ['x'] });
        const violations = rule().check(ctx());
        expect(violations[0].message).toContain('already merged');
    });
});

// Conflict-block steering (Bug #3): mid-work conflicts recommend the update-only flow, but if a PR is
// already open (cached openPr) the block steers ONLY to the PR flow — the update-only flow would just
// fail-fast, so recommending it would waste the AI's tokens.
describe('feature-branch-guard conflict steering', () => {
    beforeEach(() => {
        state.branch = 'dean/x';
        state.status = null;
    });

    it('with NO open PR, steers to the UPDATE-ONLY flow and lists the conflicting files', () => {
        state.status = status({ conflict: true, conflictFiles: ['src/a.ts', 'src/b.ts'] });
        const violations = rule().check(ctx());
        expect(violations.length).toBe(1);
        expect(violations[0].message).toContain('src/a.ts');
        expect(violations[0].message).toContain('wp-start-update');
        expect(violations[0].message).toContain('wp-finish-update');
        expect(violations[0].message).toContain('wp-start-upsert-pr');
    });

    it('with an open PR, steers ONLY to the PR flow (no wasted update-only steps)', () => {
        state.status = status({ conflict: true, conflictFiles: ['src/a.ts'], openPr: '303' });
        const violations = rule().check(ctx());
        expect(violations.length).toBe(1);
        expect(violations[0].message).toContain('#303');
        expect(violations[0].message).toContain('wp-start-upsert-pr');
        expect(violations[0].message).toContain('wp-finish-upsert-pr');
        // Must NOT tell the AI to run the update-only flow — it would just fail-fast.
        expect(violations[0].message).not.toContain('wp-start-update');
    });
});
