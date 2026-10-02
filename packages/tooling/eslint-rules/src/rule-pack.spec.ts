import plugin from './index';
import { describe, it, expect } from 'vitest';
import { rulePackManifest } from './rule-pack';
import { RulePackRegistry } from '@webpieces/rules-config';

describe('eslint-rules compatibility manifest', () => {
    it('declares unique owned schemas with the supported API and real package version', () => {
        expect(rulePackManifest.apiVersion).toBe(1);
        expect(rulePackManifest.packageVersion).toBeTruthy();
        expect(new Set(rulePackManifest.ownedRules.map(rule => rule.id)).size).toBe(rulePackManifest.ownedRules.length);
        for (const rule of rulePackManifest.ownedRules) {
            expect(rule.schemaApiVersion).toBe(1);
            expect(rule.schema['mode'].enumValues).toEqual(['ON', 'OFF']);
        }
    });

    it('provides exactly one native implementation for each owned policy', () => {
        const own = rulePackManifest.contributions.filter(contribution => contribution.ownerPack === rulePackManifest.packageName);
        expect(own.map(contribution => contribution.ruleId).sort()).toEqual(rulePackManifest.ownedRules.map(rule => rule.id).sort());
        const ownerOnly = new RulePackRegistry([{ ...rulePackManifest, contributions: own }]);
        expect(ownerOnly.ruleIds().length).toBe(rulePackManifest.ownedRules.length);
    });
});

it('lint contributions match the actual plugin registry', () => {
    expect(rulePackManifest.contributions.map(contribution => contribution.ruleId).sort()).toEqual(Object.keys(plugin.rules).sort());
});
