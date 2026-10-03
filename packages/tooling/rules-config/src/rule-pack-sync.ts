import * as fs from 'node:fs';
import * as path from 'node:path';
import { injectable, bindingScopeValues } from 'inversify';
import { ConfigObject, OwnedRuleDefinition } from '@webpieces/rules-sdk';
import { AtomicFile, InformAiError } from '@webpieces/tooling-common';
import { ConfigFile, CONFIG_FILENAME } from './config-file';
import {
    PackPolicyDeclaration,
    PackPolicyFiles,
    PackPolicyFilesResult,
    SelectedPolicyPack,
} from './pack-policy-files';
import { RulePackArtifacts } from './rule-pack-artifacts';
import { RulePackRegistry } from './rule-pack-registry';
import { validateTopLevelKeys } from './config-key-rules';
import { validateCommandsSection } from './commands-section-validators';
import { validateExcludePaths, validateMatchRulesSection } from './validate-config';
import { prepareLegacyUpgrade } from './legacy-config-upgrade';

export class RulePackSyncOptions {
    constructor(
        readonly mode: 'sync' | 'upgrade',
        readonly declarations: readonly PackPolicyDeclaration[] | null,
    ) {}
}

class OwnerFilePlan {
    constructor(
        readonly filename: string,
        readonly entries: Record<string, ConfigObject>,
    ) {}
}

/** Explicit file mutation; normal configuration loading never calls this service. */
@injectable(bindingScopeValues.Singleton)
export class RulePackSync {
    constructor(
        private readonly configFile: ConfigFile,
        private readonly files: PackPolicyFiles,
        private readonly artifacts: RulePackArtifacts,
        private readonly atomic: AtomicFile,
    ) {}

    run(root: string, options: RulePackSyncOptions): readonly string[] {
        const filename = path.join(root, CONFIG_FILENAME);
        // webpieces-disable no-any-unknown -- migration reads opaque JSON only at this explicit command boundary
        const document = this.configFile.readRawConfig(filename) as Record<string, unknown>;
        const declarations =
            options.declarations ?? this.selectedDeclarations(document, root, options.mode);
        const selected = this.files.select(root, this.files.declarations(declarations, root));
        const registry = new RulePackRegistry(
            selected.map((pack: SelectedPolicyPack) => pack.manifest),
        );
        for (const pack of selected)
            registry.recordModuleLocation(pack.manifest.packageName, pack.declaration.moduleName());
        const upgraded =
            options.mode === 'upgrade' ? this.upgradeDocument(document, registry) : document;
        const legacy =
            options.mode === 'upgrade'
                ? this.legacyEntries(upgraded, registry)
                : new Map<string, ConfigObject>();
        const prepared = this.prepare(root, selected, registry, legacy);
        const next = this.rootDocument(upgraded, declarations, options.mode);
        this.validateRoot(next, root);
        // Validate artifact data and canonical destination paths before changing any owner file.
        this.artifacts.render(prepared.resolved);
        this.artifacts.paths(root);
        const changed: string[] = [];
        for (const plan of prepared.plans) {
            if (
                this.atomic.writeIfChanged(
                    plan.filename,
                    JSON.stringify(plan.entries, null, 2) + '\n',
                )
            )
                changed.push(plan.filename);
        }
        changed.push(...this.artifacts.write(root, prepared.resolved));
        // Commit the root declaration last: all referenced files have already been validated and written.
        if (this.atomic.writeIfChanged(filename, JSON.stringify(next, null, 2) + '\n'))
            changed.push(filename);
        return changed;
    }

    // webpieces-disable no-any-unknown -- only an explicit upgrade may read the previous root shape
    private selectedDeclarations(
        // webpieces-disable no-any-unknown -- external JSON or runtime exports are validated before policy execution
        document: Record<string, unknown>,
        root: string,
        mode: 'sync' | 'upgrade',
    ): readonly PackPolicyDeclaration[] {
        if (document['rulePacks'] !== undefined)
            return this.files.declarations(document['rulePacks'], root);
        if (mode !== 'upgrade') return this.files.declarations(undefined, root);
        const pkg = this.configFile.readRawConfig(path.join(root, 'package.json')) as Record<
            string,
            // webpieces-disable no-any-unknown -- external JSON or runtime exports are validated before policy execution
            unknown
        >;
        const metadata = this.object(pkg['webpieces'], 'package.json.webpieces');
        const entries = metadata['rulePacks'];
        if (!Array.isArray(entries) || !entries.length) {
            throw new InformAiError(
                'Upgrade requires explicit pack selection. Supply --pack=<package>=.webpieces/rules/<owner>.json for every selected pack. Installed dependencies are never inferred as selected packs.',
            );
        }
        // webpieces-disable no-any-unknown -- external JSON or runtime exports are validated before policy execution
        return entries.map((entry: unknown) => {
            const declaration = this.object(entry, 'legacy package.json.webpieces.rulePacks entry');
            const moduleName = declaration['module'];
            if (typeof moduleName !== 'string' || !moduleName.endsWith('/rule-pack')) {
                throw new InformAiError(
                    'Legacy pack modules must end in /rule-pack. Supply explicit --pack=<package-or-module>=<config.json> declarations for other modules.',
                );
            }
            const packageName = moduleName.slice(0, -'/rule-pack'.length);
            return new PackPolicyDeclaration(
                packageName,
                `.webpieces/rules/${packageName.split('/').at(-1)}.json`,
            );
        });
    }

    // webpieces-disable no-any-unknown -- inherited settings and untyped directory rules cannot be silently converted into declared owners
    private upgradeDocument(
        // webpieces-disable no-any-unknown -- external JSON or runtime exports are validated before policy execution
        document: Record<string, unknown>,
        registry: RulePackRegistry,
    // webpieces-disable no-any-unknown -- external JSON or runtime exports are validated before policy execution
    ): Record<string, unknown> {
        if (document['extends'] !== undefined)
            throw new InformAiError(
                'Remove extends after making inherited values explicit. Upgrade cannot infer inherited policy settings.',
            );
        const directories = document['rulesDir'];
        if (
            directories !== undefined &&
            (!Array.isArray(directories) || directories.length !== 0)
        ) {
            throw new InformAiError(
                'Replace rulesDir with a declared client rule pack, its owned schemas, and implementation modules before upgrade. Directory implementations cannot supply an inferred schema.',
            );
        }
        if (!Object.hasOwn(document, 'rules') && !Object.hasOwn(document, 'hookGuards'))
            return document;
        const prepared = prepareLegacyUpgrade(structuredClone(document), registry);
        return { ...document, ...prepared.config };
    }

    // webpieces-disable no-any-unknown -- explicit upgrade gathers settings by canonical owner after applying owner-declared retirements
    private legacyEntries(
        // webpieces-disable no-any-unknown -- external JSON or runtime exports are validated before policy execution
        document: Record<string, unknown>,
        registry: RulePackRegistry,
    ): Map<string, ConfigObject> {
        if (document['extends'] !== undefined)
            throw new InformAiError(
                'Remove extends after making inherited values explicit. Upgrade cannot infer inherited policy settings.',
            );
        const directories = document['rulesDir'];
        if (
            directories !== undefined &&
            (!Array.isArray(directories) || directories.length !== 0)
        ) {
            throw new InformAiError(
                'Replace rulesDir with a declared client rule pack, its owned schemas, and implementation modules before upgrade. Directory implementations cannot supply an inferred schema.',
            );
        }
        const entries = new Map<string, ConfigObject>();
        for (const section of ['rules', 'hookGuards']) {
            if (document[section] === undefined) continue;
            const old = this.object(document[section], section);
            for (const id of Object.keys(old)) {
                if (!registry.hasRule(id))
                    throw new InformAiError(
                        `${section}.${id} has no selected owner. Declare its owner or remove the entry explicitly before upgrading.`,
                    );
                if (entries.has(id))
                    throw new InformAiError(
                        `${id} appears in both legacy sections. Choose one explicit value before upgrading.`,
                    );
                entries.set(id, this.object(old[id], `${section}.${id}`) as ConfigObject);
            }
        }
        return entries;
    }

    private prepare(
        root: string,
        selected: readonly SelectedPolicyPack[],
        registry: RulePackRegistry,
        legacy: ReadonlyMap<string, ConfigObject>,
    ): RulePackSyncPlan {
        const plans: OwnerFilePlan[] = [],
            values: Record<string, ConfigObject> = {},
            targets = new Map<string, string>();
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
                const previous = Object.hasOwn(entries, definition.id)
                    ? entries[definition.id]
                    : legacy.get(definition.id);
                if (
                    entries[definition.id] !== undefined &&
                    legacy.has(definition.id) &&
                    JSON.stringify(entries[definition.id]) !==
                        JSON.stringify(legacy.get(definition.id))
                ) {
                    errors.push(
                        `${filename}: ${definition.id} conflicts with the legacy value. Choose one explicit value before upgrade.`,
                    );
                }
                const value = this.seedMissing(previous, definition);
                errors.push(
                    ...registry
                        .validateRuleConfig(definition.id, value)
                        .map((error: string) => `${filename}: ${error}`),
                );
                entries[definition.id] = value;
                values[definition.id] = value;
                targets.set(definition.id, filename);
            }
            plans.push(new OwnerFilePlan(filename, entries));
        }
        if (errors.length) throw new InformAiError(`Sync made no changes:\n${errors.join('\n')}`);
        return new RulePackSyncPlan(
            plans,
            new PackPolicyFilesResult(registry, selected, values, targets),
        );
    }

    private seedMissing(
        previous: ConfigObject | undefined,
        definition: OwnedRuleDefinition,
    ): ConfigObject {
        const value =
            previous === undefined
                ? structuredClone(definition.recommendedSeed)
                : Object.assign(new ConfigObject(), this.object(previous, definition.id));
        for (const field of Object.keys(definition.schema)) {
            if (!definition.schema[field].optional && !Object.hasOwn(value, field)) {
                value[field] = structuredClone(definition.recommendedSeed[field]);
            }
        }
        return value;
    }

    // webpieces-disable no-any-unknown -- explicit upgrade removes only the retired sections it actually converted
    private rootDocument(
        // webpieces-disable no-any-unknown -- external JSON or runtime exports are validated before policy execution
        document: Record<string, unknown>,
        declarations: readonly PackPolicyDeclaration[],
        mode: 'sync' | 'upgrade',
    // webpieces-disable no-any-unknown -- external JSON or runtime exports are validated before policy execution
    ): Record<string, unknown> {
        const next = { ...document, rulePacks: declarations };
        if (mode === 'upgrade')
            for (const key of ['rules', 'hookGuards', 'rulesDir', 'extends'])
                // webpieces-disable no-any-unknown -- external JSON or runtime exports are validated before policy execution
                delete (next as Record<string, unknown>)[key];
        return next;
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

class RulePackSyncPlan {
    constructor(
        readonly plans: readonly OwnerFilePlan[],
        readonly resolved: PackPolicyFilesResult,
    ) {}
}
