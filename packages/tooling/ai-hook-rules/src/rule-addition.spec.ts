import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { FieldDef, BASE_RULE_SCHEMA, OwnedRuleDefinition, RuleContribution } from '@webpieces/rules-sdk';
import { loadAndValidate } from '@webpieces/rules-config';
import { policyFixture } from '@webpieces/tooling-testkit';
import { rulePackManifest } from './rule-pack';

/** A representative new owner policy reaches the real loader without any framework ID/schema edit. */
describe('owner-only rule addition', () => {
    it('demands the added policy and validates its explicit opt-out using only owner metadata', () => {
        const root = policyFixture.makeRepo('wp-owner-addition-');
        const id = 'representative-owner-policy';
        const seed = { mode: 'ON', prefix: 'Reviewed', turnOffRuleUntilEpoch: 0, turnOffRuleWhileOnBranch: null };
        const definition = new OwnedRuleDefinition(id, { mode: new FieldDef('string', ['ON', 'OFF']), prefix: new FieldDef('string'), ...BASE_RULE_SCHEMA }, 1, {}, seed, 'rules');
        const manifests = policyFixture.manifests().map(pack => pack.packageName === rulePackManifest.packageName ? {
            ...rulePackManifest,
            ownedRules: [...rulePackManifest.ownedRules, definition],
            contributions: [...rulePackManifest.contributions, new RuleContribution(id, rulePackManifest.packageName, 'source-hook')],
        } : pack);
        policyFixture.declareIn(root, manifests);
        const rules = {}, hookGuards = {};
        for (const pack of manifests) for (const rule of pack.ownedRules) {
            if (rule.id === id) continue;
            const section = rule.section === 'hookGuards' ? hookGuards : rules;
            section[rule.id] = rule.recommendedSeed;
        }
        const document = { rules, hookGuards, commands: { 'pr-gate': { mode: 'OFF' } }, excludePaths: [], 'match-rules': [] };
        const config = path.join(root, 'webpieces.config.json');
        fs.writeFileSync(config, JSON.stringify(document));
        expect(() => loadAndValidate(root)).toThrow(`[${id}] Not configured`);
        rules[id] = { ...seed, mode: 'OFF' };
        fs.writeFileSync(config, JSON.stringify(document));
        expect(loadAndValidate(root).resolved.rules.get(id)?.isOff).toBe(true);
        delete rules[id]['prefix'];
        fs.writeFileSync(config, JSON.stringify(document));
        expect(() => loadAndValidate(root)).toThrow('Missing required field "prefix"');
    });
});
