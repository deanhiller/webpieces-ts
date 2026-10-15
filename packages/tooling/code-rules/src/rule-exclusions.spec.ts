import { specTempDirs } from '@webpieces/tooling-testkit';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { BuildPolicy, ConfigObject, PolicyRuntimeRequest } from '@webpieces/rules-sdk';
import { RuleFileScope } from '@webpieces/rules-config';

import { CodeRuleRuntime } from './code-policy-composition';
import { CODE_POLICIES, CodePolicy } from './code-policy-registry';
import { recommendedSeeds } from './rule-settings';
import { ExclusionScopedPolicy } from './rule-dispatch';

// #1253 — the framework, not the rule, applies the path exclusions. Two halves are proven here:
//   1. ENFORCEMENT: every code rule the runtime composes runs inside its exclusions (global + its own),
//      for every entry of CODE_POLICIES — a rule added later is covered by this loop with no code.
//   2. ACCEPTANCE: a branch that regenerates `__generated__/graphql.ts` passes with no turnOff hatch,
//      while hand-written code on the same branch is still judged; the global list skips every rule,
//      a per-rule list skips only that rule.

const GENERATED = 'services/api/src/__generated__/graphql.ts';
const HAND_WRITTEN = 'services/api/src/OrderService.ts';
// The codegen shape that started this: `any` in the Scalars map, and a module-scope function.
const GENERATED_SOURCE = 'export type Scalars = { Enum_enum: { input: any; output: any } };\nexport function gql(): any { return 1; }\n';

function seededConfigs(ids: readonly string[], excludePaths?: Readonly<Record<string, string[]>>): Record<string, ConfigObject> {
    const configs: Record<string, ConfigObject> = {};
    for (const id of ids) {
        const config = Object.assign(new ConfigObject(), structuredClone(recommendedSeeds[id]));
        const own = excludePaths?.[id];
        if (own !== undefined) config['excludePaths'] = own;
        configs[id] = config;
    }
    return configs;
}

async function compose(ids: readonly string[], global: readonly string[], own?: Readonly<Record<string, string[]>>): Promise<readonly BuildPolicy[]> {
    return new CodeRuleRuntime().create(new PolicyRuntimeRequest('/repo', seededConfigs(ids, own), ids, global));
}

describe('enforcement — every composed code rule runs inside its framework-owned exclusions', () => {
    const ids = CODE_POLICIES.map((policy: CodePolicy) => policy.ruleId);

    it('wraps EVERY CODE_POLICIES entry, carrying the global list and the rule\'s own', async () => {
        const own = Object.fromEntries(ids.map((id: string) => [id, [`own/${id}/**`]]));
        const policies = await compose(ids, ['libraries/legacy/**'], own);
        expect(policies.map((policy: BuildPolicy) => policy.configKey).sort()).toEqual([...ids].sort());
        for (const policy of policies) {
            expect(policy).toBeInstanceOf(ExclusionScopedPolicy);
            const exclusions = (policy as ExclusionScopedPolicy).exclusions;
            expect(exclusions.excludes('libraries/legacy/src/Old.ts')).toBe(true);
            expect(exclusions.excludes(`own/${policy.configKey}/x.ts`)).toBe(true);
            // Another rule's own exclusion never leaks into this one.
            const other = ids.find((id: string) => id !== policy.configKey)!;
            expect(exclusions.excludes(`own/${other}/x.ts`)).toBe(false);
            expect(exclusions.excludes(HAND_WRITTEN)).toBe(false);
        }
    });

    it('runs the rule INSIDE the scope, so its file listings see the exclusions', async () => {
        const policy = (await compose(['no-any-unknown'], ['**/__generated__/**']))[0] as ExclusionScopedPolicy;
        let seen: string | undefined;
        const probe = new ExclusionScopedPolicy(
            {
                name: 'probe',
                configKey: 'probe',
                shouldRun: (): boolean => true,
                run: async () => {
                    seen = new RuleFileScope().current()?.ruleName;
                    return { success: true };
                },
            },
            policy.exclusions,
        );
        await probe.run('/repo');
        expect(seen).toBe('no-any-unknown');
        expect(new RuleFileScope().current()).toBeUndefined();
    });
});

function git(root: string, cmd: string): string {
    // core.hooksPath=/dev/null: keep any machine-global git hooks out of the throwaway test repo.
    return execSync(`git -c core.hooksPath=/dev/null ${cmd}`, {
        cwd: root, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
}

function write(root: string, relPath: string, content: string): void {
    const full = path.join(root, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
}

describe('acceptance — regenerated codegen output on a branch', () => {
    const RULES = ['no-any-unknown', 'no-function-outside-class'];
    let root: string;
    let savedBase: string | undefined;
    let savedHead: string | undefined;

    beforeEach(() => {
        savedBase = process.env['NX_BASE'];
        savedHead = process.env['NX_HEAD'];
        root = specTempDirs.makeReal('wp-rule-exclusions-');
        git(root, 'init -q -b main');
        git(root, 'config user.email test@test.com');
        git(root, 'config user.name test');
        write(root, 'README.md', 'x\n');
        git(root, 'add -A');
        git(root, 'commit -q -m base');
        process.env['NX_BASE'] = git(root, 'rev-parse HEAD');
        delete process.env['NX_HEAD'];
        // The branch regenerates the codegen output.
        write(root, GENERATED, GENERATED_SOURCE);
    });

    afterEach(() => {
        if (savedBase === undefined) delete process.env['NX_BASE'];
        else process.env['NX_BASE'] = savedBase;
        if (savedHead === undefined) delete process.env['NX_HEAD'];
        else process.env['NX_HEAD'] = savedHead;
        fs.rmSync(root, { recursive: true, force: true });
    });

    async function outcome(global: readonly string[], own?: Readonly<Record<string, string[]>>): Promise<Record<string, boolean>> {
        const policies = await new CodeRuleRuntime().create(
            new PolicyRuntimeRequest(root, seededConfigs(RULES, own), RULES, global),
        );
        const results: Record<string, boolean> = {};
        for (const policy of policies) {
            expect(policy.shouldRun()).toBe(true); // no turnOff hatch involved anywhere
            results[policy.configKey] = (await policy.run(root)).success;
        }
        return results;
    }

    it('without an exclusion, both rules reject the generated file (the incident)', async () => {
        expect(await outcome([])).toEqual({ 'no-any-unknown': false, 'no-function-outside-class': false });
    });

    it('the top-level excludePaths skips EVERY rule on the generated file', async () => {
        expect(await outcome(['**/__generated__/**'])).toEqual({ 'no-any-unknown': true, 'no-function-outside-class': true });
    });

    it('…while hand-written code on the same branch is still checked', async () => {
        write(root, HAND_WRITTEN, 'export const total: any = 1;\n');
        expect(await outcome(['**/__generated__/**'])).toEqual({ 'no-any-unknown': false, 'no-function-outside-class': true });
    });

    it('a per-rule excludePaths skips ONLY that rule', async () => {
        expect(await outcome([], { 'no-any-unknown': ['**/__generated__/**'] }))
            .toEqual({ 'no-any-unknown': true, 'no-function-outside-class': false });
    });
});
