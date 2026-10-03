import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { policyFixture, specTempDirs } from '@webpieces/tooling-testkit';
import { ConfigObject, OwnedRuleDefinition, RulePackManifest } from '@webpieces/rules-sdk';
import { InformAiError } from '@webpieces/tooling-common';
import { PackPolicyDeclaration, PackPolicyFiles, SelectedPolicyPack } from './pack-policy-files';

class SplitPolicyFixture {
    readonly root = specTempDirs.make('wp-split-policy-');
    readonly files = new PackPolicyFiles();
    readonly selected: SelectedPolicyPack[];

    constructor() {
        const manifests = policyFixture.manifests();
        policyFixture.declareIn(this.root, manifests);
        this.selected = manifests.map(
            (manifest: RulePackManifest, index: number) =>
                new SelectedPolicyPack(
                    new PackPolicyDeclaration(
                        `./fixture-policy-${index}.cjs`,
                        `.webpieces/rules/pack-${index}.json`,
                    ),
                    manifest,
                ),
        );
        for (const pack of this.selected) {
            const entries = Object.fromEntries(
                pack.manifest.ownedRules.map((rule: OwnedRuleDefinition) => [
                    rule.id,
                    structuredClone(rule.recommendedSeed),
                ]),
            );
            this.write(pack, entries);
        }
    }

    write(pack: SelectedPolicyPack, entries: Record<string, ConfigObject>): void {
        const filename = this.files.configPath(this.root, pack.declaration.config);
        fs.mkdirSync(path.dirname(filename), { recursive: true });
        fs.writeFileSync(filename, JSON.stringify(entries));
    }

    entries(pack: SelectedPolicyPack): Record<string, ConfigObject> {
        return this.files.read(this.files.configPath(this.root, pack.declaration.config));
    }
}

describe('strict owner-specific policy files', () => {
    it('loads explicit owners and keeps raw options distinct from optional tuning', () => {
        const fixture = new SplitPolicyFixture();
        const selected = fixture.files.select(
            fixture.root,
            fixture.selected.map((pack: SelectedPolicyPack) => pack.declaration),
        );
        const result = fixture.files.resolve(fixture.root, selected);
        expect(result.registry.ruleIds()).toHaveLength(50);
        expect(result.values['max-file-lines']['limit']).toBeUndefined();
        expect(result.registry.optionalTuningFor('max-file-lines')['limit']).toBe(900);
        expect(result.targetFiles.get('max-file-lines')).toBe(
            path.join(fs.realpathSync(fixture.root), '.webpieces/rules/pack-0.json'),
        );
    });

    it('names the exact file for a missing required entry and never fills it', () => {
        const fixture = new SplitPolicyFixture(),
            pack = fixture.selected[0];
        const entries = fixture.entries(pack);
        delete entries['max-file-lines'];
        fixture.write(pack, entries);
        const filename = fixture.files.configPath(fixture.root, pack.declaration.config);
        const before = fs.readFileSync(filename, 'utf8');
        expect(() => fixture.files.resolve(fixture.root, fixture.selected)).toThrow(
            'pack-0.json: missing required entry max-file-lines',
        );
        expect(fs.readFileSync(filename, 'utf8')).toBe(before);
    });

    it('requires complete OFF settings and rejects cross-owner policy placement', () => {
        const fixture = new SplitPolicyFixture(),
            owner = fixture.selected[0],
            other = fixture.selected[1];
        const entries = fixture.entries(owner);
        entries['max-file-lines'] = { mode: 'OFF' };
        fixture.write(owner, entries);
        expect(() => fixture.files.resolve(fixture.root, fixture.selected)).toThrow(
            'max-file-lines.turnOffRuleUntilEpoch is required',
        );
        entries['max-file-lines'] = owner.manifest.ownedRules.find(
            (rule: OwnedRuleDefinition) => rule.id === 'max-file-lines',
        )!.recommendedSeed;
        fixture.write(owner, entries);
        const otherEntries = fixture.entries(other);
        otherEntries['max-file-lines'] = entries['max-file-lines'];
        fixture.write(other, otherEntries);
        expect(() => fixture.files.resolve(fixture.root, fixture.selected)).toThrow('Move it to');
        expect(() => fixture.files.resolve(fixture.root, fixture.selected)).toThrow('pack-0.json');
    });

    it('rejects unknown fields, malformed files, and fixed-safeguard opt-out entries', () => {
        const fixture = new SplitPolicyFixture(),
            pack = fixture.selected[0];
        const entries = fixture.entries(pack);
        entries['max-file-lines']['typo'] = true;
        fixture.write(pack, entries);
        expect(() => fixture.files.resolve(fixture.root, fixture.selected)).toThrow(
            'max-file-lines.typo is unknown',
        );
        delete entries['max-file-lines']['typo'];
        entries['version-drift'] = { mode: 'OFF' };
        fixture.write(pack, entries);
        expect(() => fixture.files.resolve(fixture.root, fixture.selected)).toThrow(
            'version-drift has no declared configurable owner',
        );
        fs.writeFileSync(fixture.files.configPath(fixture.root, pack.declaration.config), '{');
        expect(() => fixture.files.resolve(fixture.root, fixture.selected)).toThrow(
            'Cannot parse rule-pack config',
        );
        expect(() => fixture.files.resolve(fixture.root, fixture.selected)).toThrow(InformAiError);
    });

    it('rejects path escapes, root/lock collisions, and duplicate normalized paths', () => {
        const files = new PackPolicyFiles(),
            root = specTempDirs.make('wp-split-declarations-');
        for (const config of [
            '../outside.json',
            '/tmp/outside.json',
            'webpieces.config.json',
            '.webpieces/rules.lock.json',
        ]) {
            expect(() => files.declarations([{ package: 'client-policy', config }], root)).toThrow(
                'Invalid pack config path',
            );
        }
        expect(() =>
            files.declarations(
                [
                    { package: 'one', config: '.webpieces/rules/code.json' },
                    { package: 'two', config: '.webpieces/rules/../rules/code.json' },
                ],
                root,
            ),
        ).toThrow('Duplicate');
        expect(() => files.declarations([], root)).toThrow('rulePacks is required');
    });
});
