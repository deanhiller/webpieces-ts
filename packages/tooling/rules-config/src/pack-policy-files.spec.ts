import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { policyFixture, specTempDirs } from '@webpieces/tooling-testkit';
import { ConfigObject, OwnedRuleDefinition, RulePackManifest } from '@webpieces/rules-sdk';
import { InformAiError } from '@webpieces/tooling-common';
import { toError } from '@webpieces/tooling-common/to-error';
import { PackPolicyDeclaration, PackPolicyFiles, SelectedPolicyPack } from './pack-policy-files';
import { ConfigRepairError } from './config-repair-error';

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
                        `.webpieces-config/rules/pack-${index}.json`,
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

// The structured repair a config problem carries — what the hook later renders as its deny (#1273).
function thrown(action: () => void): ConfigRepairError {
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- the spec inspects the thrown structure
    try {
        action();
    } catch (err: unknown) {
        const error = toError(err);
        expect(error).toBeInstanceOf(ConfigRepairError);
        return error as ConfigRepairError;
    }
    throw new Error('expected a ConfigRepairError');
}

describe('strict owner-specific policy files', () => {
    it('loads explicit owners and keeps raw options distinct from optional tuning', () => {
        const fixture = new SplitPolicyFixture();
        const selected = fixture.files.select(
            fixture.root,
            fixture.selected.map((pack: SelectedPolicyPack) => pack.declaration),
        );
        const result = fixture.files.resolve(fixture.root, selected);
        expect(result.registry.ruleIds()).toHaveLength(52);
        expect(result.values['max-file-lines']['limit']).toBeUndefined();
        expect(result.registry.optionalTuningFor('max-file-lines')['limit']).toBe(900);
        expect(result.targetFiles.get('max-file-lines')).toBe(
            path.join(fs.realpathSync(fixture.root), '.webpieces-config/rules/pack-0.json'),
        );
    });

    it('names the exact file and the exact entry to paste for a missing required entry, and never fills it', () => {
        const fixture = new SplitPolicyFixture(),
            pack = fixture.selected[0];
        const entries = fixture.entries(pack);
        delete entries['max-file-lines'];
        fixture.write(pack, entries);
        const filename = fixture.files.configPath(fixture.root, pack.declaration.config);
        const before = fs.readFileSync(filename, 'utf8');
        const error = thrown(() => fixture.files.resolve(fixture.root, fixture.selected));
        expect(error.message).toContain('pack-0.json: missing required entry "max-file-lines"');
        const seed = pack.manifest.ownedRules.find((rule) => rule.id === 'max-file-lines')!.recommendedSeed;
        expect(error.message).toContain(`"max-file-lines": ${JSON.stringify(seed)}`);
        expect(error.cures.map((cure) => cure.editFile)).toEqual([filename]);
        expect(fs.readFileSync(filename, 'utf8')).toBe(before);
    });

    it('prints the whole owner file to create when a declared file is missing', () => {
        const fixture = new SplitPolicyFixture(),
            pack = fixture.selected[0];
        const filename = fixture.files.configPath(fixture.root, pack.declaration.config);
        fs.rmSync(filename);
        const error = thrown(() => fixture.files.resolve(fixture.root, fixture.selected));
        expect(error.message).toContain(`${filename}: missing rule-pack config for ${pack.manifest.packageName}`);
        expect(error.message).toContain('"max-file-lines": {');
        expect(error.cures.map((cure) => cure.editFile)).toEqual([filename]);
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
        const error = thrown(() => fixture.files.resolve(fixture.root, fixture.selected));
        expect(error.message).toContain('Delete the "max-file-lines" entry here and paste it into');
        expect(error.message).toContain('pack-0.json');
        expect(error.cures.map((cure) => cure.editFile)).toEqual([
            fixture.files.configPath(fixture.root, other.declaration.config),
            fixture.files.configPath(fixture.root, owner.declaration.config),
        ]);
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
            '"version-drift" has no declared configurable owner. Delete the "version-drift" entry',
        );
        fs.writeFileSync(fixture.files.configPath(fixture.root, pack.declaration.config), '{');
        expect(() => fixture.files.resolve(fixture.root, fixture.selected)).toThrow(
            'Cannot parse rule-pack config',
        );
        expect(() => fixture.files.resolve(fixture.root, fixture.selected)).toThrow(InformAiError);
    });

    it('rejects path escapes, root collisions, and duplicate normalized paths', () => {
        const files = new PackPolicyFiles(),
            root = specTempDirs.make('wp-split-declarations-');
        for (const config of ['../outside.json', '/tmp/outside.json', 'webpieces.config.json']) {
            const error = thrown(() => files.declarations([{ package: 'client-policy', config }], root));
            expect(error.message).toContain('invalid pack config path');
            expect(error.cures.map((cure) => cure.editFile)).toEqual([path.join(root, 'webpieces.config.json')]);
        }
        expect(() =>
            files.declarations(
                [
                    { package: 'one', config: '.webpieces-config/rules/code.json' },
                    { package: 'two', config: '.webpieces-config/rules/../rules/code.json' },
                ],
                root,
            ),
        ).toThrow('duplicate rule-pack declaration');
        expect(() => files.declarations([], root)).toThrow('rulePacks is required');
    });
});
