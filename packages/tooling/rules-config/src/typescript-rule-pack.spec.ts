import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { describe, it, expect } from 'vitest';
import { specTempDirs } from '@webpieces/tooling-testkit';
import { TypeScriptRequire } from '@webpieces/tooling-common';
import { PackPolicyDeclaration, PackPolicyFiles } from './pack-policy-files';
import { NodeRuleRuntimeModuleLoader, RuleRuntimeModules } from './rule-runtime-modules';

/** What the fixture's runtime module exports once loaded. */
class FixtureRuntime {
    readonly greeting!: string;
    readonly color!: string;
}

/**
 * A repo writes its local rule pack in TypeScript (#1314) — its own `no-js-files` rule admits nothing
 * else — and declares the `.ts` module in `rulePacks`. These run the REAL Node transport: the manifest
 * through PackPolicyFiles, the runtime through NodeRuleRuntimeModuleLoader, with no build step.
 */
class TypeScriptPackFixture {
    readonly root = specTempDirs.make('wp-ts-pack-');

    constructor() {
        fs.mkdirSync(path.join(this.root, 'local'));
        fs.writeFileSync(path.join(this.root, 'package.json'), '{"private":true}\n');
        // Parameter properties and an enum: syntax Node's own type stripping refuses.
        fs.writeFileSync(path.join(this.root, 'local/color.ts'), "export enum Color { RED = 'red' }\n");
        fs.writeFileSync(
            path.join(this.root, 'local/pack.ts'),
            [
                "import { Color } from './color';",
                'class Greeter { constructor(readonly name: string) {} }',
                "export const greeting: string = new Greeter('local').name;",
                'export const color: Color = Color.RED;',
                'export const rulePackManifest = {',
                "    packageName: 'local-rules', packageVersion: '0.0.0-local', apiVersion: 3,",
                "    ownedRules: [{ id: 'local-marker', schemaApiVersion: 1, optionalTuning: {}, section: 'rules',",
                "        schema: { mode: { type: 'string', enumValues: ['ON', 'OFF'] } },",
                "        recommendedSeed: { mode: 'ON', turnOffRuleUntilEpoch: 0, turnOffRuleWhileOnBranch: null },",
                "        help: { description: 'A TypeScript-declared local rule', remediation: 'Edit {configFile}.' } }],",
                "    contributions: [{ ruleId: 'local-marker', ownerPack: 'local-rules', executionKind: 'build', implementationModule: './pack.ts' }],",
                '    migrations: [], safeguards: [],',
                '};',
            ].join('\n'),
        );
        fs.writeFileSync(
            path.join(this.root, 'owner.json'),
            JSON.stringify({ 'local-marker': { mode: 'ON', turnOffRuleUntilEpoch: 0, turnOffRuleWhileOnBranch: null } }),
        );
    }
}

describe('a TypeScript rule-pack module loads through the real transport (#1314)', () => {
    it('declares a .ts module as a local manifest, never as a package with a /rule-pack export', () => {
        expect(new PackPolicyDeclaration('./local/pack.ts', 'owner.json').moduleName()).toBe('./local/pack.ts');
        expect(new PackPolicyDeclaration('./local/pack.cts', 'owner.json').moduleName()).toBe('./local/pack.cts');
        expect(new PackPolicyDeclaration('@acme/rules', 'owner.json').moduleName()).toBe('@acme/rules/rule-pack');
    });

    it('validates the manifest and loads the runtime from TypeScript source, with no build step', () => {
        const fixture = new TypeScriptPackFixture();
        const files = new PackPolicyFiles();
        const resolved = files.resolve(
            fixture.root,
            files.select(fixture.root, files.declarations([{ package: './local/pack.ts', config: 'owner.json' }], fixture.root)),
        );
        expect(resolved.registry.ownerOf('local-marker')).toBe('local-rules');

        const modules = new RuleRuntimeModules();
        const group = modules.groups(resolved.registry, 'build')[0];
        const exports = modules.load(group, new Map([['local-rules', './local/pack.ts']]), new NodeRuleRuntimeModuleLoader(fixture.root)) as FixtureRuntime;
        expect(exports.greeting).toBe('local');
        expect(exports.color).toBe('red');
    });

    it('puts the process\'s own TypeScript loader back after the load', () => {
        const fixture = new TypeScriptPackFixture();
        const requireModule = createRequire(path.join(fixture.root, 'package.json'));
        const extensions = requireModule.extensions as unknown as Record<string, object | undefined>;
        const before = extensions['.ts'];
        new TypeScriptRequire().load(requireModule, path.join(fixture.root, 'local/pack.ts'));
        expect(extensions['.ts']).toBe(before);
        expect(new TypeScriptRequire().handles('pack.cjs')).toBe(false);
    });
});
