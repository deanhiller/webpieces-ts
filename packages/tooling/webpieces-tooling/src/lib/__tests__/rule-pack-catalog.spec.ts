import { fixtureSchemas as RULE_SCHEMAS } from '@webpieces/tooling-testkit';
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { BASE_RULE_SCHEMA, FieldDef, RetiredConfigKey, RulePackManifest } from '@webpieces/rules-sdk';
import { RulePackRegistry } from '@webpieces/rules-config';

class PackPackage {
    name!: string;
    exports!: Record<string, string>;
}

/** The installation bundle is the only project already depending on every execution owner. */
class InstalledPackInventory {
    async manifests(): Promise<readonly RulePackManifest[]> {
        const tooling = path.resolve(__dirname, '../../../..');
        const manifests: RulePackManifest[] = [];
        for (const entry of fs.readdirSync(tooling, { withFileTypes: true })) {
            const packageFile = path.join(tooling, entry.name, 'package.json');
            if (!entry.isDirectory() || !fs.existsSync(packageFile)) continue;
            const pkg = JSON.parse(fs.readFileSync(packageFile, 'utf8')) as PackPackage;
            const exported = pkg.exports?.['./rule-pack'];
            if (!exported) continue;
            const source = path.resolve(tooling, entry.name, exported.replace(/\.js$/, '.ts'));
            const loaded = await import(source);
            manifests.push(loaded.rulePackManifest as RulePackManifest);
        }
        return manifests;
    }
}

describe('complete compatibility pack catalog', () => {
    it('resolves all public pack exports into one conflict-free owner/contributor registry', async () => {
        const manifests = await new InstalledPackInventory().manifests();
        expect(manifests).toHaveLength(5);
        const registry = new RulePackRegistry(manifests);
        const configured = registry.ruleIds().filter(id => Object.hasOwn(RULE_SCHEMAS, id));
        expect(configured.sort()).toEqual(Object.keys(RULE_SCHEMAS).sort());
        // #1200 deliberately permits explicit path exemptions; all other migration-era fields stay pinned.
        const suffix = RULE_SCHEMAS['required-type-suffix'];
        const expected = {
            ...RULE_SCHEMAS,
            'required-type-suffix': {
                ...suffix,
                entries: FieldDef.nonEmptyObjects({
                    ...suffix.entries.elementSchema,
                    suffixes: FieldDef.nonEmptyStrings('To exempt this path, set exempt: true and retain a non-empty suffixes list; suffixes: [] is not an exemption.'),
                    exempt: new FieldDef('boolean'),
                }),
            },
        };
        // #1253: the framework owns the universal fields — the registry merges excludePaths and reason into
        // every rule, and the per-rule allowedPaths that meant "skip these files" became that excludePaths.
        const renamed = new Set(
            registry.migrations()
                .filter((entry: RetiredConfigKey) => entry.scope === 'field' && entry.key.endsWith('.allowedPaths'))
                .map((entry: RetiredConfigKey) => entry.key.slice(0, -'.allowedPaths'.length)),
        );
        for (const id of configured) {
            const frozen: Record<string, FieldDef> = { ...expected[id as keyof typeof expected] };
            if (renamed.has(id)) delete frozen['allowedPaths'];
            expect(registry.schemaFor(id)).toEqual({ ...frozen, ...BASE_RULE_SCHEMA });
        }
        expect(registry.ruleIds().filter(id => !Object.hasOwn(RULE_SCHEMAS, id)).sort()).toEqual([
            'enforce-architecture', 'no-json-property-primitive-type', 'no-mat-cell-def', 'require-typed-template', 'wiring-format',
        ]);
    });

    // #1253 enforcement: EVERY registered rule — whichever pack owns it, added before or after this
    // change — accepts the framework-owned universal fields with no per-rule schema code. (A lint rule
    // takes the hatches and reason only: ESLint, not webpieces, decides which files it lints.)
    it('gives every registered rule the framework-owned universal fields', async () => {
        const registry = new RulePackRegistry(await new InstalledPackInventory().manifests());
        for (const id of registry.ruleIds()) {
            const universal: Record<string, string | string[]> = { reason: 'why this entry is as it is' };
            if (registry.sectionFor(id) !== 'lint') universal['excludePaths'] = ['**/__generated__/**'];
            expect(registry.validateRuleConfig(id, { ...registry.seedFor(id), ...universal }), id).toEqual([]);
            for (const hatch of ['turnOffRuleUntilEpoch', 'turnOffRuleWhileOnBranch']) {
                const missing = { ...registry.seedFor(id) };
                delete missing[hatch];
                expect(registry.validateRuleConfig(id, missing).join(), id).toContain(`${id}.${hatch} is required`);
            }
        }
    });
});

