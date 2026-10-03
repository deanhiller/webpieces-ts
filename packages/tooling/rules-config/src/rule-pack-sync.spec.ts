import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { policyFixture, specTempDirs } from '@webpieces/tooling-testkit';
import { AtomicFile } from '@webpieces/tooling-common';
import { RulePackManifest, OwnedRuleDefinition, ConfigObject } from '@webpieces/rules-sdk';
import { ConfigFile } from './config-file';
import { PackPolicyDeclaration, PackPolicyFiles } from './pack-policy-files';
import { RulePackArtifacts } from './rule-pack-artifacts';
import { RulePackSync, RulePackSyncOptions } from './rule-pack-sync';
import { loadAndValidate } from './load-config';

class SyncFixture {
    readonly root = specTempDirs.make('wp-owner-sync-');
    readonly manifests = policyFixture.manifests();
    readonly atomic = new AtomicFile();
    readonly sync = new RulePackSync(
        new ConfigFile(),
        new PackPolicyFiles(),
        new RulePackArtifacts(this.atomic),
        this.atomic,
    );
    readonly declarations = this.manifests.map(
        (manifest: RulePackManifest, index: number) =>
            new PackPolicyDeclaration(
                `./fixture-policy-${index}.cjs`,
                `.webpieces/rules/owner-${index}.json`,
            ),
    );
    readonly entries: Record<string, ConfigObject> = Object.fromEntries(
        this.manifests.flatMap((manifest: RulePackManifest) =>
            manifest.ownedRules.map((definition: OwnedRuleDefinition) => [
                definition.id,
                structuredClone(definition.recommendedSeed),
            ]),
        ),
    );

    constructor() {
        policyFixture.declareIn(this.root, this.manifests);
    }

    write(upgrade: boolean): void {
        this.atomic.writeJsonAtomic(path.join(this.root, 'webpieces.config.json'), {
            ...(upgrade
                ? { rules: this.entries, hookGuards: {}, rulesDir: [] }
                : { rulePacks: this.declarations }),
            commands: { 'pr-gate': { mode: 'OFF', buildCommand: 'pnpm test', gates: [] } },
            excludePaths: [],
            'match-rules': [],
            migrationWhy: 'Preserve chosen enforcement values.',
        });
    }

    run(mode: 'sync' | 'upgrade'): readonly string[] {
        return this.sync.run(this.root, new RulePackSyncOptions(mode, this.declarations));
    }
}

describe('explicit owner config sync and upgrade', () => {
    it('preserves existing modes, hatches and options through upgrade and is idempotent', () => {
        const fixture = new SyncFixture();
        fixture.entries['max-file-lines']['mode'] = 'OFF';
        fixture.entries['max-file-lines']['limit'] = 432;
        fixture.entries['max-file-lines']['turnOffRuleWhileOnBranch'] = 'feature/explicit';
        fixture.write(true);
        expect(() => loadAndValidate(fixture.root)).toThrow('Retired top-level key');
        expect(fixture.run('upgrade')).toHaveLength(7);
        const loaded = loadAndValidate(fixture.root);
        expect(loaded.rulesConfig['max-file-lines']).toEqual(fixture.entries['max-file-lines']);
        const root = fs.readFileSync(path.join(fixture.root, 'webpieces.config.json'), 'utf8');
        expect(root).toContain('Preserve chosen enforcement values.');
        expect(root).not.toContain('"hookGuards"');
        expect(fixture.run('sync')).toEqual([]);
    });

    it('writes reviewed seeds only during sync, and fills missing required fields without tuning defaults', () => {
        const fixture = new SyncFixture();
        fixture.write(false);
        expect(() => loadAndValidate(fixture.root)).toThrow('Missing rule-pack config');
        fixture.run('sync');
        const filename = path.join(fixture.root, fixture.declarations[0].config);
        const entries = JSON.parse(fs.readFileSync(filename, 'utf8')) as Record<
            string,
            ConfigObject
        >;
        entries['max-file-lines'] = { mode: 'OFF' };
        fixture.atomic.writeJsonAtomic(filename, entries);
        expect(() => loadAndValidate(fixture.root)).toThrow('turnOffRuleUntilEpoch is required');
        fixture.run('sync');
        const config = loadAndValidate(fixture.root).rulesConfig['max-file-lines'];
        expect(config['mode']).toBe('OFF');
        expect(config['turnOffRuleUntilEpoch']).toBe(0);
        expect(config['limit']).toBeUndefined();
    });

    it('rejects invalid settings before writing any root, owner file or artifact', () => {
        const fixture = new SyncFixture();
        fixture.entries['max-file-lines']['typo'] = true;
        fixture.write(true);
        const filename = path.join(fixture.root, 'webpieces.config.json'),
            before = fs.readFileSync(filename, 'utf8');
        expect(() => fixture.run('upgrade')).toThrow('Sync made no changes');
        expect(fs.readFileSync(filename, 'utf8')).toBe(before);
        expect(fs.existsSync(path.join(fixture.root, '.webpieces/rules'))).toBe(false);
        expect(fs.existsSync(path.join(fixture.root, '.webpieces/rules.lock.json'))).toBe(false);
    });

    it('rejects directory and inherited config instead of guessing owners or values', () => {
        const fixture = new SyncFixture();
        fixture.write(true);
        const filename = path.join(fixture.root, 'webpieces.config.json');
        const config = JSON.parse(fs.readFileSync(filename, 'utf8'));
        config.rulesDir = ['custom'];
        fixture.atomic.writeJsonAtomic(filename, config);
        expect(() => fixture.run('upgrade')).toThrow('declared client rule pack');
        config.rulesDir = [];
        config.extends = './inherited.json';
        fixture.atomic.writeJsonAtomic(filename, config);
        expect(() => fixture.run('upgrade')).toThrow('inherited values explicit');
    });
});
