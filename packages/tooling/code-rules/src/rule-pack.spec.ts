import baseline from './rule-ownership-baseline.json';
import { CODE_POLICIES } from './code-policy-registry';
import { describe, it, expect } from 'vitest';
import { rulePackManifest } from './rule-pack';
import { RulePackRegistry, validateWebpiecesConfig } from '@webpieces/rules-config';

describe('code-rules compatibility manifest', () => {
    it('declares unique owned schemas with the supported API and real package version', () => {
        expect(rulePackManifest.apiVersion).toBe(3);
        expect(rulePackManifest.packageVersion).toBeTruthy();
        expect(new Set(rulePackManifest.ownedRules.map((rule) => rule.id)).size).toBe(
            rulePackManifest.ownedRules.length,
        );
        for (const rule of rulePackManifest.ownedRules) {
            expect(rule.schemaApiVersion).toBe(1);
        }
    });

    it('provides exactly one native implementation for each owned policy', () => {
        const own = rulePackManifest.contributions.filter(
            (contribution) => contribution.ownerPack === rulePackManifest.packageName,
        );
        expect(own.map((contribution) => contribution.ruleId).sort()).toEqual(
            rulePackManifest.ownedRules.map((rule) => rule.id).sort(),
        );
        const ownerOnly = new RulePackRegistry([{ ...rulePackManifest, contributions: own }]);
        expect(ownerOnly.ruleIds().length).toBe(rulePackManifest.ownedRules.length);
    });
});

it('code manifests match the executable config bindings', () => {
    expect(rulePackManifest.ownedRules.map((rule) => rule.id).sort()).toEqual(
        CODE_POLICIES.map((binding) => binding.ruleId).sort(),
    );
});

it('preserves every existing owned schema, optional knob, and reviewed seed', () => {
    // The baseline records the schema config is VALIDATED against: the owner's fields plus the
    // framework-owned universal fields the registry merges in (#1253).
    const own = rulePackManifest.contributions.filter(
        (contribution) => contribution.ownerPack === rulePackManifest.packageName,
    );
    const registry = new RulePackRegistry([{ ...rulePackManifest, contributions: own }]);
    for (const [id, previous] of Object.entries(baseline)) {
        const rule = rulePackManifest.ownedRules.find((rule) => rule.id === id)!;
        expect(registry.schemaFor(id)).toEqual(previous.schema);
        expect(rule.optionalTuning).toEqual(previous.optionalTuning);
        expect(rule.recommendedSeed).toEqual(previous.recommendedSeed);
    }
});

it('requires explicit settings for every owned policy, including future additions', () => {
    const own = rulePackManifest.contributions.filter(
        (contribution) => contribution.ownerPack === rulePackManifest.packageName,
    );
    const registry = new RulePackRegistry([{ ...rulePackManifest, contributions: own }]);
    const all = Object.fromEntries(registry.ruleIds().map((id) => [id, registry.seedFor(id)]));
    expect(validateWebpiecesConfig(all, registry)).toEqual([]);
    for (const rule of rulePackManifest.ownedRules) {
        const configured = { ...all };
        delete configured[rule.id];
        expect(validateWebpiecesConfig(configured, registry).join('\n')).toContain(
            `[${rule.id}] Not configured`,
        );
        expect(
            Object.keys(rule.optionalTuning).every(
                (key) => key !== 'mode' && registry.schemaFor(rule.id)[key].optional,
            ),
        ).toBe(true);
        expect(
            registry.validateRuleConfig(rule.id, { ...rule.recommendedSeed, mode: 'OFF' }),
        ).toEqual([]);
        for (const [field, definition] of Object.entries(registry.schemaFor(rule.id))) {
            if (definition.optional) continue;
            const incomplete = { ...rule.recommendedSeed, mode: 'OFF' };
            delete incomplete[field];
            expect(registry.validateRuleConfig(rule.id, incomplete).join('\n')).toContain(
                `${rule.id}.${field} is required`,
            );
        }
    }
});

it('accepts an explicit suffix exemption through the real owner schema', () => {
    const own = rulePackManifest.contributions.filter(
        (entry) => entry.ownerPack === rulePackManifest.packageName,
    );
    const registry = new RulePackRegistry([{ ...rulePackManifest, contributions: own }]);
    const errors = validateWebpiecesConfig(
        {
            'required-type-suffix': {
                mode: 'RUN_EVERY_TIME',
                entries: [{ paths: ['published/**'], suffixes: ['Dto'], exempt: true }],
                turnOffRuleUntilEpoch: 0,
                turnOffRuleWhileOnBranch: null,
            },
        },
        registry,
    );
    expect(errors.filter((error: string) => error.includes('[required-type-suffix]'))).toEqual([]);
    const empty = {
        mode: 'RUN_EVERY_TIME',
        entries: [{ paths: ['published/**'], suffixes: [], exempt: true }],
        turnOffRuleUntilEpoch: 0,
        turnOffRuleWhileOnBranch: null,
    };
    expect(registry.validateRuleConfig('required-type-suffix', empty).join('\n')).toContain(
        'set exempt: true',
    );
    expect(
        validateWebpiecesConfig({ 'required-type-suffix': empty }, registry).join('\n'),
    ).toContain('set exempt: true');
    const missingChoice = { ...empty, entries: [{ paths: ['published/**'], suffixes: ['Dto'] }] };
    expect(registry.validateRuleConfig('required-type-suffix', missingChoice).join('\n')).toContain(
        'exempt is required',
    );
});
