import plugin from './index';
import { describe, it, expect } from 'vitest';
import { rulePackManifest } from './rule-pack';
import { RulePackRegistry, validateWebpiecesConfig } from '@webpieces/rules-config';

describe('eslint-rules compatibility manifest', () => {
    it('declares unique owned schemas with the supported API and real package version', () => {
        expect(rulePackManifest.apiVersion).toBe(3);
        expect(rulePackManifest.packageVersion).toBeTruthy();
        expect(new Set(rulePackManifest.ownedRules.map((rule) => rule.id)).size).toBe(
            rulePackManifest.ownedRules.length,
        );
        for (const rule of rulePackManifest.ownedRules) {
            expect(rule.schemaApiVersion).toBe(1);
            expect(rule.schema['mode'].enumValues).toEqual(['ON', 'OFF']);
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

it('lint contributions match the actual plugin registry', () => {
    expect(
        rulePackManifest.contributions.map((contribution) => contribution.ruleId).sort(),
    ).toEqual(Object.keys(plugin.rules).sort());
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
                (key) => key !== 'mode' && rule.schema[key].optional,
            ),
        ).toBe(true);
        expect(
            registry.validateRuleConfig(rule.id, { ...rule.recommendedSeed, mode: 'OFF' }),
        ).toEqual([]);
        for (const [field, definition] of Object.entries(rule.schema)) {
            if (definition.optional) continue;
            const incomplete = { ...rule.recommendedSeed, mode: 'OFF' };
            delete incomplete[field];
            expect(registry.validateRuleConfig(rule.id, incomplete).join('\n')).toContain(
                `${rule.id}.${field} is required`,
            );
        }
    }
});
