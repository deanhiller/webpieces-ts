import * as fs from 'node:fs';
import * as path from 'node:path';
import { injectable, bindingScopeValues } from 'inversify';
import { ConfigObject, FieldDef, OwnedRuleDefinition } from '@webpieces/rules-sdk';
import { AtomicFile, InformAiError, RepositoryLayout } from '@webpieces/tooling-common';
import { ConfigFile, CONFIG_FILENAME } from './config-file';
import { PackPolicyFiles, SelectedPolicyPack } from './pack-policy-files';
import { RulePackRegistry } from './rule-pack-registry';
import { validateTopLevelKeys } from './config-key-rules';
import { validateCommandsSection } from './commands-section-validators';
import { validateExcludePaths, validateMatchRulesSection } from './validate-config';

class OwnerFilePlan {
    constructor(
        readonly filename: string,
        readonly entries: Record<string, ConfigObject>,
    ) {}
}

/**
 * Writes the owners' recommended seeds into the declared owner files, for review — the installer's and
 * `wp-migrate-dirs`' explicit file mutation. Normal configuration loading never calls this service: a
 * missing entry is a deny naming the file and the entry to paste, not something loading supplies.
 */
@injectable(bindingScopeValues.Singleton)
export class RulePackSync {
    constructor(
        private readonly configFile: ConfigFile,
        private readonly files: PackPolicyFiles,
        private readonly atomic: AtomicFile,
    ) {}

    run(root: string): readonly string[] {
        const layoutChanges = new RepositoryLayout().migrate(root);
        const filename = path.join(root, CONFIG_FILENAME);
        // webpieces-disable no-any-unknown -- the sync reads opaque JSON only at this explicit command boundary
        const document = this.configFile.readRawConfig(filename) as Record<string, unknown>;
        const selected = this.files.select(root, this.files.declarations(document['rulePacks'], root));
        const registry = new RulePackRegistry(
            selected.map((pack: SelectedPolicyPack) => pack.manifest),
        );
        for (const pack of selected)
            registry.recordModuleLocation(pack.manifest.packageName, pack.declaration.moduleName());
        this.validateRoot(document, root);
        const plans = this.prepare(root, selected, registry);
        const changed: string[] = [...layoutChanges];
        for (const plan of plans) {
            if (
                this.atomic.writeIfChanged(
                    plan.filename,
                    JSON.stringify(plan.entries, null, 2) + '\n',
                )
            )
                changed.push(plan.filename);
        }
        return changed;
    }

    private prepare(
        root: string,
        selected: readonly SelectedPolicyPack[],
        registry: RulePackRegistry,
    ): readonly OwnerFilePlan[] {
        const plans: OwnerFilePlan[] = [];
        const errors: string[] = [];
        for (const pack of selected) {
            const filename = this.files.configPath(root, pack.declaration.config);
            const entries = fs.existsSync(filename) ? this.files.read(filename) : {};
            for (const id of Object.keys(entries)) {
                if (!registry.hasRule(id) || registry.ownerOf(id) !== pack.manifest.packageName) {
                    errors.push(
                        `${filename}: ${id} has another owner or is unknown. Move or remove it explicitly before sync.`,
                    );
                }
            }
            for (const definition of pack.manifest.ownedRules) {
                const value = this.seedMissing(entries[definition.id], definition, registry.schemaFor(definition.id));
                errors.push(
                    ...registry
                        .validateRuleConfig(definition.id, value)
                        .map((error: string) => `${filename}: ${error}`),
                );
                entries[definition.id] = value;
            }
            plans.push(new OwnerFilePlan(filename, entries));
        }
        if (errors.length) throw new InformAiError(`Sync made no changes:\n${errors.join('\n')}`);
        return plans;
    }

    private seedMissing(
        previous: ConfigObject | undefined,
        definition: OwnedRuleDefinition,
        // The registry's MERGED schema (owner fields + framework-owned universal fields).
        schema: Readonly<Record<string, FieldDef>>,
    ): ConfigObject {
        const value =
            previous === undefined
                ? structuredClone(definition.recommendedSeed)
                : Object.assign(new ConfigObject(), this.object(previous, definition.id));
        for (const field of Object.keys(schema)) {
            if (!schema[field].optional && !Object.hasOwn(value, field)) {
                value[field] = structuredClone(definition.recommendedSeed[field]);
            }
        }
        return value;
    }

    // webpieces-disable no-any-unknown -- the same generic-root validators run before any write
    private validateRoot(document: Record<string, unknown>, root: string): void {
        const errors = [
            ...validateTopLevelKeys(document),
            ...validateCommandsSection(document['commands'], document['pr-gate'], root),
            ...validateExcludePaths(document['excludePaths']),
            ...validateMatchRulesSection(document['match-rules']),
        ];
        if (errors.length) throw new InformAiError(`Sync made no changes:\n${errors.join('\n')}`);
    }

    // webpieces-disable no-any-unknown -- JSON object narrowing preserves explicit values for subsequent schema validation
    private object(value: unknown, label: string): Record<string, unknown> {
        if (!value || typeof value !== 'object' || Array.isArray(value))
            throw new InformAiError(`${label} must be a JSON object. Repair it before sync.`);
        // webpieces-disable no-any-unknown -- external JSON or runtime exports are validated before policy execution
        return value as Record<string, unknown>;
    }
}
