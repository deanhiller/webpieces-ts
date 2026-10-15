import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { policyFixture, specTempDirs } from '@webpieces/tooling-testkit';
import { AtomicFile } from '@webpieces/tooling-common';
import { RulePackManifest, ConfigObject } from '@webpieces/rules-sdk';
import { ConfigFile } from './config-file';
import { PackPolicyDeclaration, PackPolicyFiles } from './pack-policy-files';
import { RulePackSync } from './rule-pack-sync';
import { loadAndValidate } from './load-config';

class SyncFixture {
    readonly root = specTempDirs.make('wp-owner-sync-');
    readonly manifests = policyFixture.manifests();
    readonly atomic = new AtomicFile();
    readonly sync = new RulePackSync(new ConfigFile(), new PackPolicyFiles(), this.atomic);
    readonly declarations = this.manifests.map(
        (manifest: RulePackManifest, index: number) =>
            new PackPolicyDeclaration(
                `./fixture-policy-${index}.cjs`,
                `.webpieces-config/rules/owner-${index}.json`,
            ),
    );

    constructor() {
        policyFixture.declareIn(this.root, this.manifests);
    }

    // webpieces-disable no-any-unknown -- fixture root JSON is opaque config written for the loader
    write(extra: Record<string, unknown> = {}): void {
        this.atomic.writeJsonAtomic(path.join(this.root, 'webpieces.config.json'), {
            rulePacks: this.declarations,
            commands: { 'pr-gate': { mode: 'OFF', buildCommand: 'pnpm test', gates: [] } },
            excludePaths: [],
            'match-rules': [],
            migrationWhy: 'Preserve chosen enforcement values.',
            ...extra,
        });
    }

    run(): readonly string[] {
        return this.sync.run(this.root);
    }
}

describe('explicit owner config sync (installer and wp-migrate-dirs)', () => {
    it('migrates the retired directory while preserving explicit policy', () => {
        const fixture = new SyncFixture();
        fixture.write();
        fixture.run();
        const owner = path.join(fixture.root, fixture.declarations[0].config);
        const entries = JSON.parse(fs.readFileSync(owner, 'utf8'));
        entries['max-file-lines'].mode = 'OFF';
        entries['max-file-lines'].limit = 432;
        fs.writeFileSync(owner, JSON.stringify(entries));
        const filename = path.join(fixture.root, 'webpieces.config.json');
        const document = JSON.parse(fs.readFileSync(filename, 'utf8'));
        for (const declaration of document.rulePacks)
            declaration.config = declaration.config.replace('.webpieces-config/', '.webpieces/');
        fs.writeFileSync(filename, JSON.stringify(document));
        fs.renameSync(
            path.join(fixture.root, '.webpieces-config'),
            path.join(fixture.root, '.webpieces'),
        );
        expect(() => loadAndValidate(fixture.root)).toThrow('wp-migrate-dirs');
        fixture.run();
        expect(loadAndValidate(fixture.root).rulesConfig['max-file-lines']['mode']).toBe('OFF');
        expect(loadAndValidate(fixture.root).rulesConfig['max-file-lines']['limit']).toBe(432);
        expect(fixture.run()).toEqual([]);
    });

    it('writes reviewed seeds only during sync, and fills missing required fields without tuning defaults', () => {
        const fixture = new SyncFixture();
        fixture.write();
        expect(() => loadAndValidate(fixture.root)).toThrow('missing rule-pack config');
        fixture.run();
        const filename = path.join(fixture.root, fixture.declarations[0].config);
        const entries = JSON.parse(fs.readFileSync(filename, 'utf8')) as Record<
            string,
            ConfigObject
        >;
        entries['max-file-lines'] = { mode: 'OFF' };
        fixture.atomic.writeJsonAtomic(filename, entries);
        expect(() => loadAndValidate(fixture.root)).toThrow('turnOffRuleUntilEpoch is required');
        fixture.run();
        const config = loadAndValidate(fixture.root).rulesConfig['max-file-lines'];
        expect(config['mode']).toBe('OFF');
        expect(config['turnOffRuleUntilEpoch']).toBe(0);
        expect(config['limit']).toBeUndefined();
    });

    it('rejects invalid settings before writing any owner file', () => {
        const fixture = new SyncFixture();
        fixture.write();
        fixture.run();
        const filename = path.join(fixture.root, fixture.declarations[0].config);
        const entries = JSON.parse(fs.readFileSync(filename, 'utf8'));
        entries['max-file-lines']['typo'] = true;
        fs.writeFileSync(filename, JSON.stringify(entries));
        fs.rmSync(path.join(fixture.root, fixture.declarations[1].config));
        const before = fs.readFileSync(filename, 'utf8');
        expect(() => fixture.run()).toThrow('Sync made no changes');
        expect(fs.readFileSync(filename, 'utf8')).toBe(before);
        expect(fs.existsSync(path.join(fixture.root, fixture.declarations[1].config))).toBe(false);
    });

    it('rejects a retired root section instead of guessing owners or values', () => {
        const fixture = new SyncFixture();
        fixture.write({ rulesDir: ['custom'] });
        expect(() => fixture.run()).toThrow('Sync made no changes');
        expect(fs.existsSync(path.join(fixture.root, '.webpieces-config/rules'))).toBe(false);
    });
});
