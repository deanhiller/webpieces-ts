import 'reflect-metadata';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Container } from 'inversify';
import * as fs from 'fs';
import * as path from 'path';

import { HookApp, HookArgs, HookEvaluator, HookProcessExit, HookStdinSource, HookStdoutSink } from '@webpieces/hook-runtime';
import { MainSyncStatus, writeMainSyncStatus } from '@webpieces/repo-workflow-core';
import { MERGE_INFO_DIR, MERGE_IN_PROGRESS_FILE } from '@webpieces/rules-config';
import { RulePackManifest } from '@webpieces/rules-sdk';
import { dotWebpieces } from '@webpieces/tooling-common';
import { checkoutLayout, policyFixture, specTempDirs } from '@webpieces/tooling-testkit';

import { rulePackManifest } from '../rule-pack';
import { HookPipelineEvaluator } from './hook-pipeline-evaluator';

/**
 * ISSUE #1431 — `branch-state-guard.featureBranchMaxCommitsBehind`, L2 row 15, driven through the WHOLE
 * guards hook: stdin payload -> HookApp -> every guard -> the deny/allow bytes on stdout.
 *
 * No git runs. The hook's synchronous path spends zero git processes (hook-git-spawn-budget.spec.ts):
 * the branch is read from `.git/HEAD`, laid out here by CheckoutLayout, and the commit distance is read
 * from the main-sync cache, written here exactly as the detached refresher writes it. The only process
 * the hook would start — that detached refresher — is the one edge stubbed below.
 */

// The detached refresher spawn: a real child process, so it is the edge. Recorded, never started.
const refreshes = vi.hoisted((): string[] => []);
vi.mock('../core/main-sync-refresh', () => ({
    triggerMainSyncRefresh: (root: string, branch: string): void => { refreshes.push(`${root}#${branch}`); },
    resetMainSyncRefreshLatchForTest: (): void => undefined,
}));
// The committed shim is a generated artifact that lags this source by a release (see hook-app-golden.spec.ts).
vi.mock('../bin/hook-registration', async (importOriginal: () => Promise<typeof import('../bin/hook-registration')>) => {
    const actual = await importOriginal();
    return { ...actual, managedSurfaceDrift: (): readonly string[] => [] };
});

const FEATURE = 'dean/stale-feature';
const HOTFIX = 'prod/dean/hotfix/2026-11-18/ONE-1-fix';

class CannedStdin extends HookStdinSource {
    constructor(private readonly raw: string) { super(); }
    override read(): Promise<string> { return Promise.resolve(this.raw); }
}

class CapturedStdout extends HookStdoutSink {
    written = '';
    override write(bytes: string): void { this.written += bytes; }
}

class RecordedExit extends HookProcessExit {
    code: number | null = null;
    override exit(code: number): void { this.code = code; }
}

/** What one hook invocation emitted: '' is the allow; a deny carries its reason. */
class HookResult {
    constructor(readonly stdout: string, readonly exitCode: number) {}

    get denied(): boolean { return this.stdout.includes('"permissionDecision":"deny"'); }

    get reason(): string {
        if (this.stdout === '') return '';
        // webpieces-disable no-any-unknown -- parsing the bytes the hook just emitted; only the reason is read
        const parsed = JSON.parse(this.stdout) as { hookSpecificOutput: { permissionDecisionReason: string } };
        return parsed.hookSpecificOutput.permissionDecisionReason;
    }
}

let repo: string;

/** A checkout on `branch` with the fixture config, its threshold set (or omitted when `max` is null). */
function layOut(branch: string, max: number | null): void {
    checkoutLayout.primary(repo, branch);
    // webpieces-disable no-any-unknown -- the frozen fixture config is JSON on disk, edited in place here
    const config = JSON.parse(fs.readFileSync(path.join(__dirname, '__goldens__', 'fixture-webpieces.config.json'), 'utf8')) as Record<string, Record<string, Record<string, unknown>>>;
    const entry = config['hookGuards']['branch-state-guard'];
    if (max === null) delete entry['featureBranchMaxCommitsBehind'];
    else entry['featureBranchMaxCommitsBehind'] = max;
    const manifests = policyFixture.manifests().map((pack: RulePackManifest): RulePackManifest =>
        pack.packageName === rulePackManifest.packageName ? rulePackManifest : pack);
    policyFixture.writeOwnerConfig(repo, config, manifests);
    fs.writeFileSync(path.join(repo, 'f.txt'), 'hello\n');
}

/** The cache entry the refresher would have written for `branch`. */
function cache(branch: string, headCommitsBehind: number | null, openPr: string = ''): void {
    const status = new MainSyncStatus(branch, false, '', true, 'fork-sha', 'origin-sha', 'head-sha', false, [], new Date().toISOString());
    status.localMain = 'origin-sha';
    status.commitsBehind = 0;
    status.headCommitsBehind = headCommitsBehind;
    status.openPr = openPr;
    writeMainSyncStatus(repo, status);
}

/** An unvalidated 3-point merge marker in this tree — what `pnpm wp-start-update` leaves on a conflict. */
function mergeInProgress(): void {
    const dir = path.join(dotWebpieces.localFile(repo, MERGE_INFO_DIR), 'staged', 'stale-feature', 'merge-1');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, MERGE_IN_PROGRESS_FILE), '{"validated": false}\n');
}

async function run(toolName: string, toolInput: Record<string, string>): Promise<HookResult> {
    const stdin = JSON.stringify({
        hook_event_name: 'PreToolUse', session_id: 'sess-1431', transcript_path: '/dev/null', cwd: repo,
        tool_name: toolName, tool_input: toolInput,
    });
    const stdout = new CapturedStdout();
    const exit = new RecordedExit();
    const container = new Container({ autobind: true });
    container.bind(HookEvaluator).to(HookPipelineEvaluator);
    container.bind(HookStdinSource).toConstantValue(new CannedStdin(stdin));
    container.bind(HookStdoutSink).toConstantValue(stdout);
    container.bind(HookProcessExit).toConstantValue(exit);
    await container.get(HookApp).run(new HookArgs('guards'));
    return new HookResult(stdout.written, exit.code ?? -1);
}

const edit = (): Promise<HookResult> => run('Edit', { file_path: path.join(repo, 'f.txt'), old_string: 'hello', new_string: 'bye' });
const write = (): Promise<HookResult> => run('Write', { file_path: path.join(repo, 'new.ts'), content: 'export const a = 1;\n' });

beforeEach(() => {
    repo = path.join(specTempDirs.makeReal('wp-1431-'), 'repo');
    fs.mkdirSync(repo);
    refreshes.length = 0;
});

afterEach(() => {
    fs.rmSync(path.dirname(repo), { recursive: true, force: true });
});

describe('featureBranchMaxCommitsBehind — L2 row 15, through the guards hook (#1431)', () => {
    it('blocks an Edit on a feature branch beyond the threshold, with wp-start-update when no PR tracks it', async () => {
        layOut(FEATURE, 20);
        cache(FEATURE, 21);
        const result = await edit();
        expect(result.exitCode).toBe(0);
        expect(result.denied).toBe(true);
        expect(result.reason).toContain(`\`${FEATURE}\` is 21 commits behind origin/main`);
        expect(result.reason).toContain('featureBranchMaxCommitsBehind=20');
        expect(result.reason).toContain('No PR tracks this branch: pnpm wp-start-update');
        expect(result.reason).toContain('use pnpm wp-start-upsert-pr instead');
        expect(result.reason).toContain('ROW 15');
    });

    it('blocks a Write too, and prints ONLY the PR flow when an open PR tracks the branch', async () => {
        layOut(FEATURE, 20);
        cache(FEATURE, 40, '1500');
        const result = await write();
        expect(result.denied).toBe(true);
        expect(result.reason).toContain('An open PR (#1500) tracks this branch');
        expect(result.reason).toContain('pnpm wp-start-upsert-pr');
        expect(result.reason).not.toContain('No PR tracks this branch');
    });

    it('allows an Edit exactly at the threshold', async () => {
        layOut(FEATURE, 20);
        cache(FEATURE, 20);
        expect((await edit()).stdout).toBe('');
    });

    it('allows an Edit when the distance is unknown (an older cache, or git could not count)', async () => {
        layOut(FEATURE, 20);
        cache(FEATURE, null);
        expect((await edit()).stdout).toBe('');
    });

    it('allows Read and Bash beyond the threshold, so the agent can look around and run the cure', async () => {
        layOut(FEATURE, 20);
        cache(FEATURE, 99);
        expect((await run('Read', { file_path: path.join(repo, 'f.txt') })).stdout).toBe('');
        expect((await run('Bash', { command: 'echo hi' })).stdout).toBe('');
    });

    it('never blocks a /hotfix/ branch, however far behind (L2 row 14)', async () => {
        layOut(HOTFIX, 20);
        cache(HOTFIX, 500);
        expect((await edit()).stdout).toBe('');
    });

    it('stands down while a 3-point merge is being resolved in this tree (L2 row 3)', async () => {
        layOut(FEATURE, 20);
        cache(FEATURE, 21);
        mergeInProgress();
        expect((await edit()).stdout).toBe('');
    });

    it('honours the configured value, not a built-in one', async () => {
        layOut(FEATURE, 3);
        cache(FEATURE, 4);
        expect((await edit()).denied).toBe(true);
    });

    it('fails the config load, naming the field, when the entry omits featureBranchMaxCommitsBehind', async () => {
        layOut(FEATURE, null);
        cache(FEATURE, 0);
        const result = await edit();
        expect(result.denied).toBe(true);
        expect(result.reason).toContain('featureBranchMaxCommitsBehind');
        expect(result.reason).toContain('branch-state-guard');
    });
});
