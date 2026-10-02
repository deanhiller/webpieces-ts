import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { FieldDef, OwnedRuleDefinition, RuleContribution, RulePackManifest, RulePackDeclaration } from '@webpieces/rules-sdk';
import { specTempDirs } from '@webpieces/tooling-testkit';
import { RulePackRegistry, NodeRulePackModuleLoader } from '@webpieces/rules-config';

class Packs {
    static owner(name = 'client-policy'): RulePackManifest {
        return new RulePackManifest(name, '1.2.3', 1, [new OwnedRuleDefinition('client-rule', { mode: new FieldDef('string', ['ON', 'OFF']), limit: new FieldDef('number') }, 1)], [new RuleContribution('client-rule', name, 'build')]);
    }
}

describe('explicit rule pack registry', () => {
    it('loads an independent client module through public discovery and validates its custom schema', () => {
        const root = specTempDirs.make('wp-client-pack-');
        fs.writeFileSync(path.join(root, 'package.json'), '{"private":true}');
        fs.writeFileSync(path.join(root, 'client-pack.cjs'), `module.exports.rulePackManifest = {
            packageName: 'client-policy', packageVersion: '1.2.3', apiVersion: 1,
            ownedRules: [{ id: 'client-rule', schemaApiVersion: 1, schema: {
                mode: { type: 'string', enumValues: ['ON', 'OFF'] },
                paths: { type: 'string[]', nonEmpty: true },
                entries: { type: 'object[]', elementSchema: { suffix: { type: 'string' } } }
            }}], contributions: [{ ruleId: 'client-rule', ownerPack: 'client-policy', executionKind: 'build' }]
        };`);
        const registry = RulePackRegistry.discover([new RulePackDeclaration('./client-pack.cjs')], new NodeRulePackModuleLoader(root));
        expect(registry.ownerOf('client-rule')).toBe('client-policy');
        expect(registry.validateRuleConfig('client-rule', { mode: 'ON', paths: ['src/**'], entries: [{ suffix: 'Dto' }] })).toEqual([]);
        expect(registry.validateRuleConfig('client-rule', { mode: 'ON', paths: [], entries: [{}], typo: true })).toEqual([
            'client-rule.typo is unknown. Use a field declared by its owner.',
            'client-rule.paths must contain at least one entry.',
            'client-rule.entries[0].suffix is required. Add an explicit string value.',
        ]);
    });

    it('requires each required field even when a rule is explicitly OFF', () => {
        const registry = new RulePackRegistry([Packs.owner()]);
        expect(registry.validateRuleConfig('client-rule', { mode: 'OFF' })).toEqual(['client-rule.limit is required. Add an explicit number value.']);
        expect(registry.validateRuleConfig('client-rule', { mode: 'MAYBE', limit: '10' })).toEqual(['client-rule.mode must be one of ON, OFF.', 'client-rule.limit must be number.']);
    });

    it('rejects duplicate owners, including duplicate IDs within a pack', () => {
        expect(() => new RulePackRegistry([Packs.owner(), Packs.owner('other-owner')])).toThrow('multiple owners');
        const owner = Packs.owner();
        expect(() => new RulePackRegistry([new RulePackManifest(owner.packageName, owner.packageVersion, 1, [...owner.ownedRules, ...owner.ownedRules], [])])).toThrow('multiple owners');
    });

    it('rejects unknown owners and mismatched owner names', () => {
        for (const ownerPack of ['missing', 'other-owner']) {
            const contributor = new RulePackManifest('contributor', '1.0.0', 1, [], [new RuleContribution('client-rule', ownerPack, 'lint')]);
            expect(() => new RulePackRegistry([Packs.owner(), contributor])).toThrow('Unknown owner');
        }
    });

    it('rejects duplicate execution kinds but accepts independent build and lint contributions', () => {
        const contributor = new RulePackManifest('linter', '1.0.0', 1, [], [new RuleContribution('client-rule', 'client-policy', 'lint')]);
        expect(new RulePackRegistry([Packs.owner(), contributor]).ruleIds()).toEqual(['client-rule']);
        const duplicate = new RulePackManifest('other-builder', '1.0.0', 1, [], [new RuleContribution('client-rule', 'client-policy', 'build')]);
        expect(() => new RulePackRegistry([Packs.owner(), duplicate])).toThrow('Duplicate execution-kind');
    });

    it('rejects incompatible manifest and schema APIs without implicit upgrades', () => {
        expect(() => new RulePackRegistry([new RulePackManifest('future', '2.0.0', 2, [], [])])).toThrow('Unsupported manifest API');
        expect(() => new RulePackRegistry([new RulePackManifest('future', '2.0.0', 1, [new OwnedRuleDefinition('future-rule', {}, 2)], [])])).toThrow('Unsupported schema API');
    });

    it('rejects duplicate pack declarations and unknown rules', () => {
        expect(() => new RulePackRegistry([Packs.owner(), Packs.owner()])).toThrow('Duplicate pack');
        expect(() => new RulePackRegistry([]).schemaFor('missing-rule')).toThrow('Unknown rule');
    });
    it('rejects malformed external schemas before registry queries can use them', () => {
        const root = specTempDirs.make('wp-invalid-pack-');
        fs.writeFileSync(path.join(root, 'package.json'), '{"private":true}');
        const file = path.join(root, 'invalid.cjs');
        fs.writeFileSync(file, `module.exports.rulePackManifest = {
            packageName: 'client-policy', packageVersion: '1.0.0', apiVersion: 1,
            ownedRules: [{ id: 'broken', schemaApiVersion: 1, schema: { entries: { type: 'object[]' } } }],
            contributions: []
        };`);
        expect(() => RulePackRegistry.discover([new RulePackDeclaration('./invalid.cjs')], new NodeRulePackModuleLoader(root))).toThrow('Invalid schema');
        fs.writeFileSync(path.join(root, 'missing.cjs'), 'module.exports = {};');
        expect(() => RulePackRegistry.discover([new RulePackDeclaration('./missing.cjs')], new NodeRulePackModuleLoader(root))).toThrow('must export rulePackManifest');
    });

});
