import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
    ConfigObject,
    FieldDef,
    OwnedRuleDefinition,
    RuleContribution,
    RuleHelp,
    RulePackManifest,
} from '@webpieces/rules-sdk';
import { specTempDirs } from '@webpieces/tooling-testkit';
import { PackPolicyFiles } from './pack-policy-files';
import { NodeRuleRuntimeModuleLoader, RuleRuntimeModules } from './rule-runtime-modules';

class ClientPolicyConfig extends ConfigObject {
    constructor(
        readonly mode: string,
        readonly requiredMarker: string,
    ) {
        super();
    }
}

class ClientRuntimeFixture {
    readonly root = specTempDirs.make('wp-client-runtime-');
    readonly config = new ClientPolicyConfig('ON', 'expected client content');

    constructor() {
        fs.mkdirSync(path.join(this.root, 'client-pack'));
        fs.writeFileSync(path.join(this.root, 'package.json'), '{"private":true}\n');
        const definition = new OwnedRuleDefinition(
            'client-marker',
            { mode: new FieldDef('string', ['ON', 'OFF']), requiredMarker: new FieldDef('string') },
            1,
            {},
            this.config,
            'rules',
            new RuleHelp('Require client-authored content', 'Edit {configFile} explicitly.'),
        );
        const manifest = new RulePackManifest(
            '@client/policy',
            '1.0.0',
            3,
            [definition],
            [new RuleContribution('client-marker', '@client/policy', 'build', './runtime.cjs')],
            [],
            [],
        );
        fs.writeFileSync(
            path.join(this.root, 'client-pack/manifest.cjs'),
            `exports.rulePackManifest = ${JSON.stringify(manifest)};\n`,
        );
        fs.writeFileSync(
            path.join(this.root, 'client-pack/runtime.cjs'),
            `
const fs = require('node:fs');
const path = require('node:path');
exports.buildRuleRuntime = {
    async create(request) {
        return request.ruleIds.map(id => ({
            name: id, configKey: id,
            shouldRun() { return request.configs[id].mode !== 'OFF'; },
            async run(root) {
                const content = fs.readFileSync(path.join(root, 'client-input.txt'), 'utf8');
                fs.writeFileSync(path.join(root, 'execution.txt'), content);
                return { success: content === request.configs[id].requiredMarker };
            }
        }));
    }
};
`,
        );
        fs.writeFileSync(
            path.join(this.root, 'owner.json'),
            JSON.stringify({ 'client-marker': this.config }),
        );
    }

    resolve(): ReturnType<PackPolicyFiles['resolve']> {
        const files = new PackPolicyFiles();
        const declarations = files.declarations(
            [{ package: './client-pack/manifest.cjs', config: 'owner.json' }],
            this.root,
        );
        return files.resolve(this.root, files.select(this.root, declarations));
    }
}

describe('client-owned policy runtime through real Node module transport', () => {
    it('validates a client schema and executes its contribution relative to the declared manifest', async () => {
        const client = new ClientRuntimeFixture(),
            resolved = client.resolve(),
            modules = new RuleRuntimeModules();
        const group = modules.groups(resolved.registry, 'build')[0];
        const providerModules = new Map(
            resolved.selected.map((pack) => [
                pack.manifest.packageName,
                pack.declaration.moduleName(),
            ]),
        );
        const exports = modules.load(
            group,
            providerModules,
            new NodeRuleRuntimeModuleLoader(client.root),
        );
        const request = modules.request(client.root, resolved.values, group);
        const checks = await modules.createBuildPolicies(exports, request);
        fs.writeFileSync(path.join(client.root, 'client-input.txt'), client.config.requiredMarker);
        expect(checks[0].shouldRun()).toBe(true);
        expect((await checks[0].run(client.root)).success).toBe(true);
        expect(fs.readFileSync(path.join(client.root, 'execution.txt'), 'utf8')).toBe(
            client.config.requiredMarker,
        );
        fs.writeFileSync(path.join(client.root, 'client-input.txt'), 'incorrect client content');
        expect((await checks[0].run(client.root)).success).toBe(false);
        expect(resolved.values['client-marker']).toEqual(client.config);
    });

    it('requires complete settings even OFF and runs no check when explicitly opted out', async () => {
        const client = new ClientRuntimeFixture();
        fs.writeFileSync(path.join(client.root, 'owner.json'), '{"client-marker":{"mode":"OFF"}}');
        expect(() => client.resolve()).toThrow(/owner.json.*requiredMarker is required/);
        fs.writeFileSync(
            path.join(client.root, 'owner.json'),
            JSON.stringify({ 'client-marker': new ClientPolicyConfig('OFF', 'explicit') }),
        );
        const resolved = client.resolve(),
            modules = new RuleRuntimeModules(),
            group = modules.groups(resolved.registry, 'build')[0];
        const exports = modules.load(
            group,
            new Map([['@client/policy', './client-pack/manifest.cjs']]),
            new NodeRuleRuntimeModuleLoader(client.root),
        );
        const checks = await modules.createBuildPolicies(
            exports,
            modules.request(client.root, resolved.values, group),
        );
        expect(checks[0].shouldRun()).toBe(false);
        expect(fs.existsSync(path.join(client.root, 'execution.txt'))).toBe(false);
    });

    it('rejects malformed exports, omitted implementations, and undeclared config keys', async () => {
        const client = new ClientRuntimeFixture(),
            modules = new RuleRuntimeModules(),
            resolved = client.resolve();
        const request = modules.request(
            client.root,
            resolved.values,
            modules.groups(resolved.registry, 'build')[0],
        );
        await expect(modules.createBuildPolicies({}, request)).rejects.toThrow(
            'must export buildRuleRuntime',
        );
        await expect(
            modules.createBuildPolicies({ buildRuleRuntime: { create: async () => [] } }, request),
        ).rejects.toThrow('omitted declared policy client-marker');
        await expect(
            modules.createBuildPolicies(
                {
                    buildRuleRuntime: {
                        create: async () => [
                            {
                                name: 'fake',
                                configKey: 'foreign',
                                shouldRun: () => true,
                                run: async () => ({ success: true }),
                            },
                        ],
                    },
                },
                request,
            ),
        ).rejects.toThrow('Invalid build check');
    });
});
