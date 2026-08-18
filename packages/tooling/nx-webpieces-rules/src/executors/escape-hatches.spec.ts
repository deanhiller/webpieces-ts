/**
 * THE TWO UNIVERSAL ESCAPE HATCHES ACTUALLY REACH THE SKIP DECISION.
 *
 * Every webpieces rule honors `turnOffRuleUntilEpoch` (skip until an epoch passes) and
 * `turnOffRuleWhileOnBranch` (skip while that branch is checked out). Three nx executors read those
 * options out of webpieces.config.json themselves rather than through a shared validator base:
 * `runtime-architecture`, `validate-ts-in-src` and `no-file-import-cycles`.
 *
 * All three were reading the RETIRED spellings of those two keys (named, once, in
 * rules-config's RENAMED_FIELD_ALIASES), which the config loader rejects outright — so the lookup could
 * only ever return `undefined` and both hatches were silent no-ops for those three rules on every
 * branch. Nothing was red; the hatch just did not work.
 *
 * Every `it` below FAILS against that code (the option is read under a key the config cannot contain,
 * so the rule keeps enforcing) and passes once the read uses the live spelling. The spelling itself is
 * ratcheted separately by lib/__tests__/escape-hatch-key-spelling.spec.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import type { ExecutorContext } from '@nx/devkit';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

type RulesConfigModule = typeof import('@webpieces/rules-config');

/** Mutable rule bag the mocked config loader serves. Hoisted so vi.mock's factory can close over it. */
const configState = vi.hoisted(() => ({ rules: new Map<string, Record<string, unknown>>() }));

vi.mock('@webpieces/rules-config', async (importOriginal: () => Promise<RulesConfigModule>) => {
    const actual = await importOriginal();
    return {
        ...actual,
        // Only the FILE READ is faked. shouldSkipRule, the thing under test, stays the real one.
        loadAndValidate: (): { resolved: InstanceType<typeof actual.ResolvedConfig> } => {
            const rules = new Map(
                Array.from(configState.rules, ([name, options]) => [name, new actual.ResolvedRuleConfig(options)]),
            );
            return { resolved: new actual.ResolvedConfig(rules, new Set<string>(), [], null) };
        },
    };
});

// validate-ts-in-src builds the Nx project graph as its FIRST act once it decides to enforce. Making
// that throw turns "the hatch did not skip" into a loud failure instead of a slow real graph build.
vi.mock('@nx/devkit', () => ({
    createProjectGraphAsync: (): Promise<never> => {
        throw new Error('ENFORCED: validate-ts-in-src built the project graph, so the hatch did NOT skip');
    },
    readProjectsConfigurationFromProjectGraph: (): never => {
        throw new Error('ENFORCED: validate-ts-in-src read project configs, so the hatch did NOT skip');
    },
}));

import { loadRuntimeConfig, runtimeReportOnly, RUNTIME_RULE_NAME } from '../lib/runtime-config';
import runTsInSrcExecutor from './validate-ts-in-src/executor';
import runCyclesExecutor from './validate-no-file-import-cycles/executor';

const HATCH_BRANCH = 'dean/some-huge-refactor';
const FUTURE_EPOCH = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30;
const PAST_EPOCH = Math.floor(Date.now() / 1000) - 60 * 60 * 24 * 30;

function setRule(name: string, options: Record<string, unknown>): void {
    configState.rules.set(name, options);
}

/** Pretend a branch is checked out the way skip-rule's documented CI override does. */
function onBranch(branch: string): void {
    process.env['WEBPIECES_BRANCH'] = branch;
}

function context(root: string, projectName?: string): ExecutorContext {
    return { root, projectName } as unknown as ExecutorContext;
}

describe('escape hatches reach the skip decision', () => {
    const originalBranch = process.env['WEBPIECES_BRANCH'];
    const originalHeadRef = process.env['GITHUB_HEAD_REF'];

    beforeEach(() => {
        configState.rules.clear();
        // GITHUB_HEAD_REF wins over WEBPIECES_BRANCH inside getCurrentBranch, so it must be cleared or
        // a CI run of this suite would resolve the wrong branch.
        delete process.env['GITHUB_HEAD_REF'];
        onBranch('dean/unrelated-branch');
        vi.spyOn(console, 'log').mockImplementation(() => undefined);
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
    });

    afterEach(() => {
        vi.restoreAllMocks();
        if (originalBranch === undefined) delete process.env['WEBPIECES_BRANCH'];
        else process.env['WEBPIECES_BRANCH'] = originalBranch;
        if (originalHeadRef === undefined) delete process.env['GITHUB_HEAD_REF'];
        else process.env['GITHUB_HEAD_REF'] = originalHeadRef;
    });

    // ---------------------------------------------------------------- runtime-architecture

    describe('runtime-architecture', () => {
        it('does NOT skip with the hatches at their inert defaults (baseline)', () => {
            setRule(RUNTIME_RULE_NAME, { mode: 'ON', turnOffRuleUntilEpoch: PAST_EPOCH, turnOffRuleWhileOnBranch: null });
            expect(runtimeReportOnly(loadRuntimeConfig('/ws')).skip).toBe(false);
        });

        it('skips while turnOffRuleUntilEpoch is in the future', () => {
            setRule(RUNTIME_RULE_NAME, { mode: 'ON', turnOffRuleUntilEpoch: FUTURE_EPOCH, turnOffRuleWhileOnBranch: null });
            expect(runtimeReportOnly(loadRuntimeConfig('/ws')).skip).toBe(true);
        });

        it('skips while turnOffRuleWhileOnBranch names the checked-out branch', () => {
            onBranch(HATCH_BRANCH);
            setRule(RUNTIME_RULE_NAME, { mode: 'ON', turnOffRuleUntilEpoch: PAST_EPOCH, turnOffRuleWhileOnBranch: HATCH_BRANCH });
            const result = runtimeReportOnly(loadRuntimeConfig('/ws'));
            expect(result.skip).toBe(true);
            expect(result.reason).toContain(HATCH_BRANCH);
        });

        it('does NOT skip when turnOffRuleWhileOnBranch names a DIFFERENT branch', () => {
            onBranch('dean/other');
            setRule(RUNTIME_RULE_NAME, { mode: 'ON', turnOffRuleUntilEpoch: PAST_EPOCH, turnOffRuleWhileOnBranch: HATCH_BRANCH });
            expect(runtimeReportOnly(loadRuntimeConfig('/ws')).skip).toBe(false);
        });
    });

    // ---------------------------------------------------------------- validate-ts-in-src

    describe('validate-ts-in-src', () => {
        const RULE = 'validate-ts-in-src';

        beforeEach(() => {
            // Without a base the executor bails out early ("could not detect base branch") and never
            // reaches the graph — which would make the enforcing baseline below indistinguishable from
            // a skip. Naming a base forces it down the real enforcing path.
            process.env['NX_BASE'] = 'main';
        });

        afterEach(() => {
            delete process.env['NX_BASE'];
        });

        it('ENFORCES (builds the graph) when neither hatch is active — proves the mock is load-bearing', async () => {
            setRule(RULE, { mode: 'NEW_AND_MODIFIED_FILES', turnOffRuleUntilEpoch: PAST_EPOCH, turnOffRuleWhileOnBranch: null });
            await expect(runTsInSrcExecutor({}, context('/ws'))).rejects.toThrow(/ENFORCED/);
        });

        it('skips (never builds the graph) while turnOffRuleUntilEpoch is in the future', async () => {
            setRule(RULE, { mode: 'NEW_AND_MODIFIED_FILES', turnOffRuleUntilEpoch: FUTURE_EPOCH, turnOffRuleWhileOnBranch: null });
            await expect(runTsInSrcExecutor({}, context('/ws'))).resolves.toEqual({ success: true });
        });

        it('skips while turnOffRuleWhileOnBranch names the checked-out branch', async () => {
            onBranch(HATCH_BRANCH);
            setRule(RULE, { mode: 'NEW_AND_MODIFIED_FILES', turnOffRuleUntilEpoch: PAST_EPOCH, turnOffRuleWhileOnBranch: HATCH_BRANCH });
            await expect(runTsInSrcExecutor({}, context('/ws'))).resolves.toEqual({ success: true });
        });
    });

    // ---------------------------------------------------------------- no-file-import-cycles

    describe('no-file-import-cycles', () => {
        const RULE = 'no-file-import-cycles';
        let workspaceRoot = '';

        beforeAll(() => {
            // A real, genuinely circular project — the gate runs REAL madge over it, so "the hatch
            // worked" means the executor saw the cycle and still returned success.
            workspaceRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hatch-cycles-')));
            const srcDir = path.join(workspaceRoot, 'src');
            fs.mkdirSync(srcDir, { recursive: true });
            fs.writeFileSync(path.join(srcDir, 'a.ts'), `import './b';\nexport const a = 1;\n`);
            fs.writeFileSync(path.join(srcDir, 'b.ts'), `import './a';\nexport const b = 2;\n`);
        });

        afterAll(() => {
            fs.rmSync(workspaceRoot, { recursive: true, force: true });
        });

        it('FAILS on the cycle when neither hatch is active (baseline)', async () => {
            setRule(RULE, { mode: 'RUN_EVERY_TIME', turnOffRuleUntilEpoch: PAST_EPOCH, turnOffRuleWhileOnBranch: null });
            const result = await runCyclesExecutor({}, context(workspaceRoot, 'proj'));
            expect(result.success).toBe(false);
        });

        // Shim shape #6: the failure text used to prescribe the RETIRED key, so a caller who followed
        // it wrote a config the loader then rejected. The remedy must name a key that actually loads.
        it('prescribes a key the config loader ACCEPTS when it fails', async () => {
            setRule(RULE, { mode: 'RUN_EVERY_TIME', turnOffRuleUntilEpoch: PAST_EPOCH, turnOffRuleWhileOnBranch: null });
            await runCyclesExecutor({}, context(workspaceRoot, 'proj'));
            const printed = vi.mocked(console.error).mock.calls.map((args: unknown[]) => String(args[0])).join('\n');
            expect(printed).toContain('turnOffRuleUntilEpoch');
            expect(printed).toContain('turnOffRuleWhileOnBranch');
        });

        it('reports but PASSES while turnOffRuleUntilEpoch is in the future', async () => {
            setRule(RULE, { mode: 'RUN_EVERY_TIME', turnOffRuleUntilEpoch: FUTURE_EPOCH, turnOffRuleWhileOnBranch: null });
            const result = await runCyclesExecutor({}, context(workspaceRoot, 'proj'));
            expect(result.success).toBe(true);
        });

        it('reports but PASSES while turnOffRuleWhileOnBranch names the checked-out branch', async () => {
            onBranch(HATCH_BRANCH);
            setRule(RULE, { mode: 'RUN_EVERY_TIME', turnOffRuleUntilEpoch: PAST_EPOCH, turnOffRuleWhileOnBranch: HATCH_BRANCH });
            const result = await runCyclesExecutor({}, context(workspaceRoot, 'proj'));
            expect(result.success).toBe(true);
        });
    });
});
