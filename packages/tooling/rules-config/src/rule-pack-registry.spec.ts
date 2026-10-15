import { RuleHelp } from '@webpieces/rules-sdk';
import { policyFixture } from '@webpieces/tooling-testkit';
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    BASE_RULE_SCHEMA,
    FieldDef,
    OwnedRuleDefinition,
    RuleContribution,
    RulePackManifest,
    RulePackDeclaration,
} from '@webpieces/rules-sdk';
import { specTempDirs } from '@webpieces/tooling-testkit';
import { InformAiError } from '@webpieces/tooling-common';
import {
    RulePackRegistry,
    NodeRulePackModuleLoader,
    RulePackDiscovery,
} from '@webpieces/rules-config';

class Packs {
    static owner(name = 'client-policy'): RulePackManifest {
        return new RulePackManifest(
            name,
            '1.2.3',
            3,
            [
                new OwnedRuleDefinition(
                    'client-rule',
                    { mode: new FieldDef('string', ['ON', 'OFF']), limit: new FieldDef('number') },
                    1,
                    {},
                    { mode: 'ON', limit: 0, turnOffRuleUntilEpoch: 0, turnOffRuleWhileOnBranch: null },
                    'rules',
                    new RuleHelp(
                        'Client-owned policy',
                        'Configure this policy explicitly in {configFile}.',
                    ),
                ),
            ],
            [new RuleContribution('client-rule', name, 'build', './client-runtime.cjs')],
            [],
            [],
        );
    }
}

describe('explicit rule pack registry', () => {
    it('loads an independent client module through public discovery and validates its custom schema', () => {
        const root = policyFixture.makeRepo('wp-client-pack-');
        fs.writeFileSync(path.join(root, 'package.json'), '{"private":true}');
        fs.writeFileSync(
            path.join(root, 'client-pack.cjs'),
            `module.exports.rulePackManifest = {
            packageName: 'client-policy', packageVersion: '1.2.3', apiVersion: 3, migrations: [], safeguards: [],
            ownedRules: [{ id: 'client-rule', schemaApiVersion: 1, optionalTuning: {}, recommendedSeed: { mode: 'ON', paths: ['src/**'], entries: [{ suffix: 'Dto' }], turnOffRuleUntilEpoch: 0, turnOffRuleWhileOnBranch: null }, section: 'rules', help: { description: 'Client policy', remediation: 'Configure in {configFile}.' }, schema: {
                mode: { type: 'string', enumValues: ['ON', 'OFF'] },
                paths: { type: 'string[]', nonEmpty: true },
                entries: { type: 'object[]', elementSchema: { suffix: { type: 'string' } } }
            }}], contributions: [{ ruleId: 'client-rule', ownerPack: 'client-policy', executionKind: 'build', implementationModule: './client-runtime.cjs' }]
        };`,
        );
        const registry = new RulePackDiscovery(new NodeRulePackModuleLoader(root)).discover([
            new RulePackDeclaration('./client-pack.cjs'),
        ]);
        expect(registry.ownerOf('client-rule')).toBe('client-policy');
        expect(
            registry.validateRuleConfig('client-rule', {
                mode: 'ON',
                paths: ['src/**'],
                entries: [{ suffix: 'Dto' }],
                turnOffRuleUntilEpoch: 0,
                turnOffRuleWhileOnBranch: null,
            }),
        ).toEqual([]);
        expect(
            registry.validateRuleConfig('client-rule', {
                mode: 'ON',
                paths: [],
                entries: [{}],
                typo: true,
                turnOffRuleUntilEpoch: 0,
                turnOffRuleWhileOnBranch: null,
            }),
        ).toEqual([
            'client-rule.typo is unknown. Use a field declared by its owner.',
            'client-rule.paths must contain at least one entry.',
            'client-rule.entries[0].suffix is required. Add an explicit string value.',
        ]);
    });

    it('requires each required field even when a rule is explicitly OFF', () => {
        const registry = new RulePackRegistry([Packs.owner()]);
        // The framework-owned hatches are demanded of a client rule whose schema never named them (#1253).
        expect(registry.validateRuleConfig('client-rule', { mode: 'OFF' })).toEqual([
            'client-rule.limit is required. Add an explicit number value.',
            'client-rule.turnOffRuleUntilEpoch is required. Add an explicit number value.',
            'client-rule.turnOffRuleWhileOnBranch is required. Add an explicit string value.',
        ]);
        expect(registry.validateRuleConfig('client-rule', { mode: 'MAYBE', limit: '10', turnOffRuleUntilEpoch: 0, turnOffRuleWhileOnBranch: null })).toEqual([
            'client-rule.mode must be one of ON, OFF.',
            'client-rule.limit must be number.',
        ]);
    });

    it('rejects duplicate owners, including duplicate IDs within a pack', () => {
        expect(() => new RulePackRegistry([Packs.owner(), Packs.owner('other-owner')])).toThrow(
            'multiple owners',
        );
        expect(() => new RulePackRegistry([Packs.owner(), Packs.owner('other-owner')])).toThrow(
            InformAiError,
        );
        const owner = Packs.owner();
        expect(
            () =>
                new RulePackRegistry([
                    new RulePackManifest(
                        owner.packageName,
                        owner.packageVersion,
                        3,
                        [...owner.ownedRules, ...owner.ownedRules],
                        [],
                        [],
                        [],
                    ),
                ]),
        ).toThrow('multiple owners');
    });

    it('rejects unknown owners and mismatched owner names', () => {
        for (const ownerPack of ['missing', 'other-owner']) {
            const contributor = new RulePackManifest(
                'contributor',
                '1.0.0',
                3,
                [],
                [new RuleContribution('client-rule', ownerPack, 'lint', './client-runtime.cjs')],
                [],
                [],
            );
            expect(() => new RulePackRegistry([Packs.owner(), contributor])).toThrow(
                'Unknown owner',
            );
        }
    });

    it('rejects duplicate execution kinds but accepts independent build and lint contributions', () => {
        const contributor = new RulePackManifest(
            'linter',
            '1.0.0',
            3,
            [],
            [new RuleContribution('client-rule', 'client-policy', 'lint', './client-runtime.cjs')],
            [],
            [],
        );
        expect(new RulePackRegistry([Packs.owner(), contributor]).ruleIds()).toEqual([
            'client-rule',
        ]);
        const duplicate = new RulePackManifest(
            'other-builder',
            '1.0.0',
            3,
            [],
            [new RuleContribution('client-rule', 'client-policy', 'build', './client-runtime.cjs')],
            [],
            [],
        );
        expect(() => new RulePackRegistry([Packs.owner(), duplicate])).toThrow(
            'Duplicate execution-kind',
        );
    });

    it('rejects incompatible manifest and schema APIs without implicit upgrades', () => {
        expect(
            () =>
                new RulePackRegistry([new RulePackManifest('future', '2.0.0', 4, [], [], [], [])]),
        ).toThrow('Unsupported manifest API');
        expect(
            () =>
                new RulePackRegistry([new RulePackManifest('future', '2.0.0', 4, [], [], [], [])]),
        ).toThrow(InformAiError);
        expect(
            () =>
                new RulePackRegistry([
                    new RulePackManifest(
                        'future',
                        '2.0.0',
                        3,
                        [
                            new OwnedRuleDefinition(
                                'future-rule',
                                {},
                                2,
                                {},
                                { mode: 'ON', limit: 0, turnOffRuleUntilEpoch: 0, turnOffRuleWhileOnBranch: null },
                                'rules',
                                new RuleHelp(
                                    'Client-owned policy',
                                    'Configure this policy explicitly in {configFile}.',
                                ),
                            ),
                        ],
                        [],
                        [],
                        [],
                    ),
                ]),
        ).toThrow('Unsupported schema API');
        expect(
            () =>
                new RulePackRegistry([
                    new RulePackManifest(
                        'future',
                        '2.0.0',
                        3,
                        [
                            new OwnedRuleDefinition(
                                'future-rule',
                                {},
                                2,
                                {},
                                { mode: 'ON', limit: 0, turnOffRuleUntilEpoch: 0, turnOffRuleWhileOnBranch: null },
                                'rules',
                                new RuleHelp(
                                    'Client-owned policy',
                                    'Configure this policy explicitly in {configFile}.',
                                ),
                            ),
                        ],
                        [],
                        [],
                        [],
                    ),
                ]),
        ).toThrow(InformAiError);
    });

    it('rejects duplicate pack declarations and unknown rules', () => {
        expect(() => new RulePackRegistry([Packs.owner(), Packs.owner()])).toThrow(
            'Duplicate pack',
        );
        expect(() => new RulePackRegistry([]).schemaFor('missing-rule')).toThrow('Unknown rule');
    });
    it('rejects malformed external schemas before registry queries can use them', () => {
        const root = policyFixture.makeRepo('wp-invalid-pack-');
        fs.writeFileSync(path.join(root, 'package.json'), '{"private":true}');
        const file = path.join(root, 'invalid.cjs');
        fs.writeFileSync(
            file,
            `module.exports.rulePackManifest = {
            packageName: 'client-policy', packageVersion: '1.0.0', apiVersion: 3, migrations: [], safeguards: [],
            ownedRules: [{ id: 'broken', schemaApiVersion: 1, optionalTuning: {}, recommendedSeed: {}, section: 'rules', help: { description: 'Client policy', remediation: 'Configure in {configFile}.' }, schema: { entries: { type: 'object[]' } } }],
            contributions: []
        };`,
        );
        expect(() =>
            new RulePackDiscovery(new NodeRulePackModuleLoader(root)).discover([
                new RulePackDeclaration('./invalid.cjs'),
            ]),
        ).toThrow('Invalid schema');
        expect(() =>
            new RulePackDiscovery(new NodeRulePackModuleLoader(root)).discover([
                new RulePackDeclaration('./invalid.cjs'),
            ]),
        ).toThrow(InformAiError);
        fs.writeFileSync(path.join(root, 'missing.cjs'), 'module.exports = {};');
        expect(() =>
            new RulePackDiscovery(new NodeRulePackModuleLoader(root)).discover([
                new RulePackDeclaration('./missing.cjs'),
            ]),
        ).toThrow('must export rulePackManifest');
        expect(() =>
            new RulePackDiscovery(new NodeRulePackModuleLoader(root)).discover([
                new RulePackDeclaration('./missing.cjs'),
            ]),
        ).toThrow(InformAiError);
    });

    // #1253: the framework owns the universal fields. A pack schema never declares them; the registry
    // merges them into EVERY owned rule, so a rule added later has them with no code of its own.
    describe('framework-owned universal fields', () => {
        const hatches = { turnOffRuleUntilEpoch: 0, turnOffRuleWhileOnBranch: null };

        it('accepts excludePaths and a reason on a rule whose schema never named them', () => {
            const registry = new RulePackRegistry([Packs.owner()]);
            expect(Object.keys(registry.schemaFor('client-rule')).sort()).toEqual(
                ['excludePaths', 'limit', 'mode', 'reason', 'turnOffRuleUntilEpoch', 'turnOffRuleWhileOnBranch'],
            );
            expect(
                registry.validateRuleConfig('client-rule', {
                    mode: 'ON', limit: 1, ...hatches,
                    excludePaths: ['**/__generated__/**'], reason: 'codegen output is not ours to fix',
                }),
            ).toEqual([]);
            expect(registry.validateRuleConfig('client-rule', { mode: 'ON', limit: 1, ...hatches, excludePaths: 'x' }))
                .toEqual(['client-rule.excludePaths must be string[].']);
        });

        it('refuses a pack that declares a universal field even with the framework definition', () => {
            const pack = Packs.owner();
            const spread = new OwnedRuleDefinition(
                'client-rule',
                { mode: new FieldDef('string', ['ON', 'OFF']), limit: new FieldDef('number'), ...BASE_RULE_SCHEMA },
                1, {}, { mode: 'ON', limit: 0, ...hatches }, 'rules', new RuleHelp('d', 'r {configFile}'),
            );
            expect(() => new RulePackRegistry([{ ...pack, ownedRules: [spread] }]))
                .toThrow('declares the framework-owned field "turnOffRuleUntilEpoch"');
        });

        it('refuses a pack that redeclares a universal field with a different meaning', () => {
            const pack = Packs.owner();
            const redeclared = new OwnedRuleDefinition(
                'client-rule',
                { mode: new FieldDef('string', ['ON', 'OFF']), limit: new FieldDef('number'), excludePaths: new FieldDef('string') },
                1, {}, { mode: 'ON', limit: 0, ...hatches }, 'rules', new RuleHelp('d', 'r {configFile}'),
            );
            expect(() => new RulePackRegistry([{ ...pack, ownedRules: [redeclared] }]))
                .toThrow('declares the framework-owned field "excludePaths"');
        });

        it('refuses a default (optional tuning) for a universal field', () => {
            const pack = Packs.owner();
            const tuned = new OwnedRuleDefinition(
                'client-rule',
                { mode: new FieldDef('string', ['ON', 'OFF']), limit: new FieldDef('number') },
                1, { excludePaths: ['dist/**'] }, { mode: 'ON', limit: 0, ...hatches }, 'rules', new RuleHelp('d', 'r {configFile}'),
            );
            expect(() => new RulePackRegistry([{ ...pack, ownedRules: [tuned] }])).toThrow('cannot have a default');
        });

        it('gives a lint rule the hatches and reason but not excludePaths, which ESLint could not honour', () => {
            const pack = Packs.owner();
            const lint = new OwnedRuleDefinition(
                'client-rule', { mode: new FieldDef('string', ['ON', 'OFF']) }, 1, {}, { mode: 'ON', ...hatches },
                'lint', new RuleHelp('d', 'r {configFile}'),
            );
            const registry = new RulePackRegistry([{ ...pack, ownedRules: [lint], contributions: [] }]);
            expect(Object.keys(registry.schemaFor('client-rule')).sort())
                .toEqual(['mode', 'reason', 'turnOffRuleUntilEpoch', 'turnOffRuleWhileOnBranch']);
            expect(registry.validateRuleConfig('client-rule', { mode: 'ON', ...hatches, excludePaths: [] }).join())
                .toContain('client-rule.excludePaths is unknown');
        });
    });
});
