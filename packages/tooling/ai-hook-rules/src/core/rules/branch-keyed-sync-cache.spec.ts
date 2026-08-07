import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
    MainSyncFileStore,
    MainSyncStatus,
    MainSyncStatusFile,
    MergedBranchBashGuardConfig,
    FeatureBranchGuardConfig,
} from '@webpieces/rules-config';

import { BashContext, FileContext } from '../types';

type RulesConfigModule = typeof import('@webpieces/rules-config');

/**
 * THE regression this change exists for.
 *
 * `<primary>/.webpieces/main-sync-status.json` is ONE file shared by every worktree of the repo, and
 * it used to describe exactly ONE branch — whichever tree won the single-flight lock. Every guard
 * bails out with `stale-cross-branch-cache (fail-open)` when the cached branch is not the branch it is
 * judging, so with N worktrees at most one worktree's guards were armed and the rest silently
 * abstained (and which one was armed thrashed as the lock changed hands).
 *
 * These tests drive the real guards against ONE branch-keyed document and assert that a guard judging
 * EITHER branch is armed, and that neither ever reaches the cross-branch bail-out.
 */

// The whole cache, and the branch the live tree reports — the two inputs a guard combines.
const state = vi.hoisted(() => ({
    branch: 'deanhiller/feat',
    cacheFile: '',
}));

// Every decision the guards logged this test, so an "armed" claim can be checked against the REASON
// the guard recorded rather than only against the verdict.
const log = vi.hoisted(() => ({ reasons: [] as string[] }));

vi.mock('child_process', () => ({
    execSync: (cmd: string): string => (cmd.includes('--abbrev-ref') ? `${state.branch}\n` : ''),
}));

// readMainSyncStatus goes through the REAL file parse + branch lookup, over a REAL document on disk —
// only the path resolution is replaced. That keeps the v1 adapter and the miss path under test.
vi.mock('@webpieces/rules-config', async (importActual: () => Promise<RulesConfigModule>) => {
    const actual = await importActual();
    const store = new actual.MainSyncFileStore();
    return {
        ...actual,
        readMainSyncStatus: (_root: string, branch: string): MainSyncStatus | null =>
            store.branchStatus(store.readFile(state.cacheFile), branch),
    };
});

vi.mock('../main-sync-refresh', () => ({ triggerMainSyncRefresh: (): void => undefined }));
vi.mock('../decision-log', () => ({
    logGuardDecision: (_root: string, decision: { reason: string }): void => { log.reasons.push(decision.reason); },
    GuardDecision: class {
        reason: string;
        constructor(_rule: string, _tool: string, _target: string, _branch: string, _verdict: string, reason: string) {
            this.reason = reason;
        }
    },
}));

import { MergedBranchBashGuardRule } from './merged-branch-bash-guard';
import { FeatureBranchGuardRule } from './feature-branch-guard';

function status(branch: string, merged: boolean): MainSyncStatus {
    const built = new MainSyncStatus(
        branch, merged, merged ? '194' : '', true, 'fork', 'origin-sha', `head-${branch}`, false, [], 'ts');
    built.localMain = 'local-sha';
    return built;
}

// Put a document on disk where the mocked reader will find it.
function writeCache(document: MainSyncStatusFile | MainSyncStatus): void {
    fs.writeFileSync(state.cacheFile, JSON.stringify(document, null, 2));
}

// One document describing TWO worktrees' branches — the shape the winning refresher now writes.
function twoWorktreeCache(): MainSyncStatusFile {
    return new MainSyncStatusFile(2, 'ts', {
        'main': status('main', false),
        'deanhiller/feat': status('deanhiller/feat', true),
        'deanhiller/other': status('deanhiller/other', true),
    });
}

function bashGuardBlocks(branch: string): boolean {
    state.branch = branch;
    return new MergedBranchBashGuardRule(armedBashConfig()).check(new BashContext('pnpm test', '/tmp/x')).length > 0;
}

function editGuardBlocks(branch: string): boolean {
    state.branch = branch;
    const cfg = new FeatureBranchGuardConfig();
    cfg.mode = 'ON';
    return new FeatureBranchGuardRule(cfg).check(new FileContext('/tmp/x/src/a.ts', 'src/a.ts', '/tmp/x')).length > 0;
}

function armedBashConfig(): MergedBranchBashGuardConfig {
    const cfg = new MergedBranchBashGuardConfig();
    cfg.mode = 'ON';
    return cfg;
}

let dir = '';

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bksc-'));
    state.cacheFile = path.join(dir, 'main-sync-status.json');
    writeCache(twoWorktreeCache());
    log.reasons = [];
});

afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('branch-keyed main-sync cache — every worktree stays armed', () => {
    // TEST 1: the regression. Both worktrees' branches are described by ONE file, so a guard judging
    // either one is armed. Under the old single-branch file exactly one of these two could block.
    it('arms the guards for BOTH branches from a single cache document', () => {
        expect(bashGuardBlocks('deanhiller/feat')).toBe(true);
        expect(bashGuardBlocks('deanhiller/other')).toBe(true);
        expect(editGuardBlocks('deanhiller/feat')).toBe(true);
        expect(editGuardBlocks('deanhiller/other')).toBe(true);
    });

    it('never reaches the cross-branch bail-out for a branch the cache describes', () => {
        bashGuardBlocks('deanhiller/feat');
        bashGuardBlocks('deanhiller/other');
        editGuardBlocks('deanhiller/other');
        expect(log.reasons).not.toContain('stale-cross-branch-cache');
        expect(log.reasons).not.toContain('no-sync-cache');
        expect(log.reasons.filter((r: string): boolean => r.startsWith('already-merged'))).toHaveLength(3);
    });

    // TEST 2: a branch the refresh never saw is a MISS, which is the same fail-open the guards already
    // took for a missing file — NOT a cross-branch read of someone else's signals.
    it('fails open with no-sync-cache for a branch absent from the map', () => {
        expect(bashGuardBlocks('deanhiller/brand-new')).toBe(false);
        expect(editGuardBlocks('deanhiller/brand-new')).toBe(false);
        expect(log.reasons).toEqual(['no-sync-cache', 'no-sync-cache']);
    });

    // TEST 3: a v1 document, written by the PREVIOUS release and still on disk after the upgrade.
    // Its one branch stays armed; every other branch misses and fails open.
    it('still arms the one branch of a v1 (pre-map) cache, and only that branch', () => {
        writeCache(status('deanhiller/feat', true));

        expect(bashGuardBlocks('deanhiller/feat')).toBe(true);
        expect(bashGuardBlocks('deanhiller/other')).toBe(false);
        expect(log.reasons).toContain('no-sync-cache');
        expect(log.reasons).not.toContain('stale-cross-branch-cache');
    });

    // A clean (unmerged) entry must still read as clean — the map changed the lookup, not the verdicts.
    it('leaves an unmerged branch allowed, on its own entry', () => {
        writeCache(new MainSyncStatusFile(2, 'ts', {
            'deanhiller/feat': status('deanhiller/feat', false),
            'deanhiller/other': status('deanhiller/other', true),
        }));
        expect(bashGuardBlocks('deanhiller/feat')).toBe(false);
        expect(bashGuardBlocks('deanhiller/other')).toBe(true);
        expect(log.reasons).toContain('clean-feature-branch');
    });

    // The belt-and-braces assertion the four guards keep: if a map KEY and the entry's own `branch`
    // field ever disagree (a shape bug, unreachable in normal operation) the guard must allow, not
    // block on another branch's signals.
    it('still fails open when a map key and its entry disagree (defensive assertion)', () => {
        writeCache(new MainSyncStatusFile(2, 'ts', {
            'deanhiller/feat': status('someone/else', true),
        }));
        expect(bashGuardBlocks('deanhiller/feat')).toBe(false);
        expect(log.reasons).toContain('stale-cross-branch-cache');
    });

    // Sanity: MainSyncFileStore is exported from the package root, which is how the refresher and the
    // guards share one parser.
    it('exports the store from the package root', () => {
        expect(new MainSyncFileStore()).toBeInstanceOf(MainSyncFileStore);
    });
});
