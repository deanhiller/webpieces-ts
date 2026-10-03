import { fixtureSchemas as RULE_SCHEMAS } from '@webpieces/tooling-testkit';
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { RulePackManifest } from '@webpieces/rules-sdk';
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
        for (const id of configured) expect(registry.schemaFor(id)).toEqual(RULE_SCHEMAS[id]);
        expect(registry.ruleIds().filter(id => !Object.hasOwn(RULE_SCHEMAS, id)).sort()).toEqual([
            'enforce-architecture', 'no-json-property-primitive-type', 'no-mat-cell-def', 'require-typed-template',
        ]);
    });
});
