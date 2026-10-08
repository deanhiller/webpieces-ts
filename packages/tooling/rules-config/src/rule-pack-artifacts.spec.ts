import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { policyFixture, specTempDirs } from '@webpieces/tooling-testkit';
import { ConfigObject, RulePackManifest } from '@webpieces/rules-sdk';
import { AtomicFile } from '@webpieces/tooling-common';
import { RulePackRegistry } from './rule-pack-registry';
import {
    PackPolicyDeclaration,
    PackPolicyFilesResult,
    SelectedPolicyPack,
} from './pack-policy-files';
import { RulePackArtifacts, RULE_CATALOG_FILE, RULE_LOCK_FILE } from './rule-pack-artifacts';

class DecodedLockPack {
    ownedRules!: ConfigObject[];
}

class DecodedRuleLock {
    packs!: DecodedLockPack[];
}

class ArtifactFixture {
    readonly root = specTempDirs.make('wp-rule-artifacts-');
    readonly manifests = structuredClone(policyFixture.manifests());
    readonly artifacts = new RulePackArtifacts(new AtomicFile());

    result(manifests: readonly RulePackManifest[] = this.manifests): PackPolicyFilesResult {
        const registry = new RulePackRegistry(manifests);
        const selected = manifests.map(
            (manifest: RulePackManifest) =>
                new SelectedPolicyPack(
                    new PackPolicyDeclaration(
                        manifest.packageName,
                        `.webpieces/rules/${manifest.packageName.split('/')[1]}.json`,
                    ),
                    manifest,
                ),
        );
        const values: Record<string, ConfigObject> = {},
            targets = new Map<string, string>();
        for (const pack of selected) {
            for (const definition of pack.manifest.ownedRules) {
                values[definition.id] = registry.seedFor(definition.id);
                targets.set(definition.id, path.join(this.root, pack.declaration.config));
            }
        }
        return new PackPolicyFilesResult(registry, selected, values, targets);
    }
}

describe('committed artifacts from the resolved rule registry', () => {
    it('writes deterministic lock/catalog bytes independent of declaration order and skips identical writes', () => {
        const fixture = new ArtifactFixture(),
            result = fixture.result();
        const first = fixture.artifacts.render(result);
        expect(fixture.artifacts.render(fixture.result([...fixture.manifests].reverse()))).toEqual(
            first,
        );
        expect(fixture.artifacts.write(fixture.root, result)).toHaveLength(2);
        expect(fixture.artifacts.write(fixture.root, result)).toEqual([]);
        expect(() => fixture.artifacts.check(fixture.root, result)).not.toThrow();
        const lock = JSON.parse(
            fs.readFileSync(path.join(fixture.root, RULE_LOCK_FILE), 'utf8'),
        ) as DecodedRuleLock;
        expect(lock.packs).toHaveLength(4);
        expect(lock.packs.flatMap((pack: DecodedLockPack) => pack.ownedRules)).toHaveLength(51);
        expect(first.catalog).toContain('.webpieces/rules/code-rules.json');
        expect(first.catalog).not.toContain('{configFile}');
    });

    it('names missing or mismatched artifacts and never rewrites them while checking', () => {
        const fixture = new ArtifactFixture(),
            result = fixture.result();
        expect(() => fixture.artifacts.check(fixture.root, result)).toThrow(RULE_LOCK_FILE);
        fixture.artifacts.write(fixture.root, result);
        const lockFile = path.join(fixture.root, RULE_LOCK_FILE);
        fs.writeFileSync(lockFile, '{}\n');
        expect(() => fixture.artifacts.check(fixture.root, result)).toThrow('disagrees');
        expect(fs.readFileSync(lockFile, 'utf8')).toBe('{}\n');
    });

    it('detects installed version, schema/tuning metadata, and explicit mode drift', () => {
        const fixture = new ArtifactFixture(),
            result = fixture.result();
        fixture.artifacts.write(fixture.root, result);
        const manifests = fixture.manifests.map((manifest: RulePackManifest) =>
            manifest.packageName === '@webpieces/code-rules'
                ? { ...manifest, packageVersion: '2.0.0' }
                : manifest,
        );
        expect(() => fixture.artifacts.check(fixture.root, fixture.result(manifests))).toThrow(
            RULE_LOCK_FILE,
        );
        result.values['max-file-lines']['mode'] = 'OFF';
        expect(() => fixture.artifacts.check(fixture.root, result)).toThrow(RULE_CATALOG_FILE);
        expect(fixture.artifacts.render(result).lock).toBe(
            fs.readFileSync(path.join(fixture.root, RULE_LOCK_FILE), 'utf8'),
        );
    });

    it('hashes actual owner metadata and rejects executable values inside the data manifest', () => {
        const fixture = new ArtifactFixture(),
            result = fixture.result();
        const before = fixture.artifacts.render(result).lock;
        const first = result.selected[0].manifest.ownedRules[0];
        first.optionalTuning['limit'] = 123;
        expect(fixture.artifacts.render(result).lock).not.toBe(before);
        Object.assign(first.help, { hiddenFunction: (): string => 'implementation' });
        expect(() => fixture.artifacts.render(result)).toThrow('only serializable data');
    });
});
