import { describe, it, expect } from 'vitest';
import { ConfigObject, PolicyRuntimeRequest } from '@webpieces/rules-sdk';
import { ExcludePaths } from '@webpieces/rules-config';
import { filterByExcludedPaths, GovernedPath, Rule } from '@webpieces/hook-runtime';
import { SOURCE_POLICIES, SourcePolicy } from './source-policy-registry';
import { sourceRuleRuntime } from './rule-runtime';

// #1253, the hook half of the enforcement: EVERY source rule — the ten shared with the build and the
// hook-only ones — is skipped by the top-level `excludePaths` and by its own `excludePaths`, with no
// path code in any rule. The engine (filterByExcludedPaths) does it for all of them. A rule added to
// SOURCE_POLICIES later is covered by this loop without editing it.

const GENERATED = 'apps/web/src/__generated__/graphql.ts';
const HAND_WRITTEN = 'apps/web/src/OrderService.ts';

function path(relative: string): GovernedPath {
    return new GovernedPath(relative, relative, '/repo');
}

function rules(ownExcludes: readonly string[]): readonly Rule[] {
    const ids = SOURCE_POLICIES.map((policy: SourcePolicy) => policy.id);
    const configs: Record<string, ConfigObject> = {};
    for (const id of ids)
        configs[id] = Object.assign(new ConfigObject(), {
            mode: 'NEW_AND_MODIFIED_FILES',
            turnOffRuleUntilEpoch: 0,
            turnOffRuleWhileOnBranch: null,
            excludePaths: [...ownExcludes],
        });
    return sourceRuleRuntime.create(new PolicyRuntimeRequest('/repo', configs, ids, []));
}

function names(kept: readonly Rule[]): string[] {
    return kept.map((rule: Rule) => rule.name);
}

describe('framework-applied path exclusions — every source-hook rule', () => {
    it('covers every registered source rule', () => {
        expect(rules([]).length).toBe(SOURCE_POLICIES.length);
    });

    it('the top-level excludePaths drops EVERY rule on a generated file, and none on hand-written code', () => {
        const all = rules([]);
        const global = new ExcludePaths(['**/__generated__/**']);
        expect(filterByExcludedPaths(all, path(GENERATED), global)).toEqual([]);
        expect(names(filterByExcludedPaths(all, path(HAND_WRITTEN), global))).toEqual(names(all));
    });

    it('a rule\'s own excludePaths drops THAT rule only', () => {
        for (const policy of SOURCE_POLICIES) {
            const excluding = rules(['**/__generated__/**']).find((rule: Rule) => rule.configKey === policy.id)!;
            const others = rules([]).filter((rule: Rule) => rule.configKey !== policy.id);
            const kept = filterByExcludedPaths([excluding, ...others], path(GENERATED), new ExcludePaths([]));
            expect(names(kept)).toEqual(names(others));
            const handWritten = filterByExcludedPaths([excluding, ...others], path(HAND_WRITTEN), new ExcludePaths([]));
            expect(handWritten).toHaveLength(others.length + 1);
        }
    });
});
