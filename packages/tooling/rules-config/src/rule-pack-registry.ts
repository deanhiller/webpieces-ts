import { injectable, bindingScopeValues } from 'inversify';
import { createRequire } from 'node:module';
import { InformAiError } from '@webpieces/tooling-common';
import * as path from 'node:path';
import {
    FieldDef, RulePackManifest, RulePackDeclaration, OwnedRuleDefinition,
    RULE_PACK_API_VERSION, RULE_SCHEMA_API_VERSION, ConfigObject, RetiredConfigKey, SafeguardDefinition, RuleConfigSection,
} from '@webpieces/rules-sdk';

/** Loading is the only impure boundary; callers may supply an alternative module transport. */
export abstract class RulePackModuleLoader {
    abstract load(moduleName: string): RulePackManifest;
}

export class NodeRulePackModuleLoader extends RulePackModuleLoader {
    private readonly requireModule: NodeRequire;

    constructor(clientRoot: string) {
        super();
        this.requireModule = createRequire(path.join(clientRoot, 'package.json'));
    }

    override load(moduleName: string): RulePackManifest {
        // webpieces-disable no-any-unknown -- external module boundary; registry validates its exported data before use
        const exports: unknown = this.requireModule(moduleName);
        if (typeof exports !== 'object' || exports === null || !('rulePackManifest' in exports)) {
            throw new InformAiError(`Rule pack ${moduleName} must export rulePackManifest. Add the public manifest export.`);
        }
        return exports.rulePackManifest as RulePackManifest;
    }
}

/** A registry depends only on declarations and the SDK, never on concrete execution packages. */
export class RulePackRegistry {
    private readonly owners = new Map<string, string>();
    private readonly definitions = new Map<string, OwnedRuleDefinition>();
    private readonly safeguards = new Map<string, SafeguardDefinition>();

    constructor(readonly manifests: readonly RulePackManifest[]) {
        const packs = new Set<string>();
        for (const manifest of manifests) {
            this.validateManifest(manifest);
            if (packs.has(manifest.packageName)) throw new InformAiError(`Duplicate pack ${manifest.packageName}. Declare it once.`);
            packs.add(manifest.packageName);
            for (const definition of manifest.ownedRules) {
                if (this.owners.has(definition.id)) throw new InformAiError(`Rule ${definition.id} has multiple owners. Keep exactly one owner.`);
                this.owners.set(definition.id, manifest.packageName);
                this.definitions.set(definition.id, definition);
            }
        }
        for (const manifest of manifests) {
            for (const safeguard of manifest.safeguards) {
                if (!safeguard || typeof safeguard.id !== 'string' || !safeguard.id ||
                    !['fixed', 'experimental'].includes(safeguard.activation) ||
                    typeof safeguard.description !== 'string' || !safeguard.description) {
                    throw new InformAiError('Invalid safeguard catalog. Supply id, activation, and description.');
                }
                if (this.owners.has(safeguard.id) || this.safeguards.has(safeguard.id)) {
                    throw new InformAiError(`Safeguard ${safeguard.id} cannot be configured or owned twice. Keep it outside configurable policies.`);
                }
                this.safeguards.set(safeguard.id, safeguard);
            }
        }
        const executions = new Set<string>();
        for (const manifest of manifests) {
            for (const contribution of manifest.contributions) {
                if (!contribution || typeof contribution.ruleId !== 'string' || typeof contribution.ownerPack !== 'string') {
                    throw new InformAiError(`Invalid contribution in ${manifest.packageName}. Supply ruleId and ownerPack.`);
                }
                const owner = this.owners.get(contribution.ruleId);
                if (!owner || owner !== contribution.ownerPack) {
                    throw new InformAiError(`Unknown owner ${contribution.ownerPack} for ${contribution.ruleId}. Declare the owning pack and use its exact name.`);
                }
                if (!['build', 'source-hook', 'workflow-guard', 'lint'].includes(contribution.executionKind)) {
                    throw new InformAiError(`Invalid execution kind for ${contribution.ruleId}. Use build, source-hook, workflow-guard, or lint.`);
                }
                const execution = `${contribution.ruleId}:${contribution.executionKind}`;
                if (executions.has(execution)) throw new InformAiError(`Duplicate execution-kind contribution ${execution}. Keep one implementation per execution kind.`);
                executions.add(execution);
            }
        }
    }

    ownerOf(ruleId: string): string {
        const owner = this.owners.get(ruleId);
        if (!owner) throw new InformAiError(`Unknown rule ${ruleId}. Declare its owning pack.`);
        return owner;
    }

    schemaFor(ruleId: string): Readonly<Record<string, FieldDef>> {
        this.ownerOf(ruleId);
        return this.definitions.get(ruleId)!.schema;
    }

    ruleIds(): readonly string[] {
        return [...this.definitions.keys()];
    }

    hasRule(ruleId: string): boolean { return this.definitions.has(ruleId); }

    isSafeguard(ruleId: string): boolean { return this.safeguards.has(ruleId); }

    sectionFor(ruleId: string): RuleConfigSection { return this.definitionFor(ruleId).section; }

    optionalTuningFor(ruleId: string): ConfigObject { return this.definitionFor(ruleId).optionalTuning; }

    seedFor(ruleId: string): ConfigObject { return structuredClone(this.definitionFor(ruleId).recommendedSeed); }

    migrations(): readonly RetiredConfigKey[] { return this.manifests.flatMap(manifest => [...manifest.migrations]); }

    safeguardCatalog(): readonly SafeguardDefinition[] { return [...this.safeguards.values()]; }

    private definitionFor(ruleId: string): OwnedRuleDefinition {
        this.ownerOf(ruleId);
        return this.definitions.get(ruleId)!;
    }

    /** Validates explicit config values with the owner's schema; supplies no rule defaults. */
    validateRuleConfig(ruleId: string, value: ConfigObject): readonly string[] {
        return this.validateObject(ruleId, this.schemaFor(ruleId), value);
    }

    private validateManifest(manifest: RulePackManifest): void {
        if (!manifest || typeof manifest.packageName !== 'string' || manifest.packageName.length === 0 ||
            typeof manifest.packageVersion !== 'string' || manifest.packageVersion.length === 0 ||
            !Array.isArray(manifest.ownedRules) || !Array.isArray(manifest.contributions) ||
            !Array.isArray(manifest.migrations) || !Array.isArray(manifest.safeguards)) {
            throw new InformAiError('Invalid rule pack manifest. Supply packageName, packageVersion, ownedRules, contributions, migrations, and safeguards.');
        }
        if (manifest.apiVersion !== RULE_PACK_API_VERSION) {
            throw new InformAiError(`Unsupported manifest API ${manifest.apiVersion} for ${manifest.packageName}. Use API ${RULE_PACK_API_VERSION}.`);
        }
        for (const definition of manifest.ownedRules) {
            if (!definition || typeof definition.id !== 'string' || definition.id.length === 0) {
                throw new InformAiError(`Invalid owned rule in ${manifest.packageName}. Supply a nonempty id.`);
            }
            if (definition.schemaApiVersion !== RULE_SCHEMA_API_VERSION) {
                throw new InformAiError(`Unsupported schema API for ${definition.id}. Use API ${RULE_SCHEMA_API_VERSION}.`);
            }
            this.validateSchema(definition.id, definition.schema);
            this.validateOwnerSettings(definition);
        }
        for (const migration of manifest.migrations) {
            if (!migration || !['rule', 'key', 'field'].includes(migration.scope) ||
                typeof migration.key !== 'string' || !migration.key ||
                typeof migration.movedTo !== 'string' || typeof migration.instruction !== 'string' ||
                !migration.instruction || typeof migration.label !== 'string' || typeof migration.prunable !== 'boolean') {
                throw new InformAiError(`Invalid migration in ${manifest.packageName}. Supply the retired key and exact edit.`);
            }
        }
    }

    private validateOwnerSettings(definition: OwnedRuleDefinition): void {
        if (!['rules', 'hookGuards', 'lint'].includes(definition.section)) {
            throw new InformAiError(`Invalid config section for ${definition.id}. Use rules, hookGuards, or lint.`);
        }
        const tuning = definition.optionalTuning;
        if (!tuning || typeof tuning !== 'object' || Array.isArray(tuning)) {
            throw new InformAiError(`Missing optional tuning for ${definition.id}. Supply an explicit object, including {} when empty.`);
        }
        for (const key of Object.keys(tuning)) {
            const field = definition.schema[key];
            if (!field || !field.optional || key === 'mode') {
                throw new InformAiError(`${definition.id}.${key} cannot have a default. Keep required behaviour in explicit repository config.`);
            }
            const errors = this.validateObject(definition.id, { [key]: field }, { [key]: tuning[key] });
            if (errors.length) throw new InformAiError(errors.join('\n'));
        }
        const errors = this.validateObject(definition.id, definition.schema, definition.recommendedSeed);
        if (errors.length) throw new InformAiError(`Invalid recommended seed: ${errors.join('\n')}. Fix the owner's seed; the loader never applies it.`);
    }

    private validateSchema(location: string, schema: Readonly<Record<string, FieldDef>>): void {
        if (!schema || typeof schema !== 'object' || Array.isArray(schema)) throw new InformAiError(`Invalid schema for ${location}. Supply a field map.`);
        for (const [key, field] of Object.entries(schema)) {
            if (!field || !['string', 'number', 'boolean', 'string[]', 'object[]'].includes(field.type)) {
                throw new InformAiError(`Invalid field ${location}.${key}. Supply a supported FieldDef type.`);
            }
            for (const flag of ['optional', 'nullable', 'nonEmpty'] as const) {
                if (field[flag] !== undefined && typeof field[flag] !== 'boolean') throw new InformAiError(`Invalid ${flag} for ${location}.${key}. Supply a boolean.`);
            }
            if (field.enumValues !== undefined && (!Array.isArray(field.enumValues) || field.enumValues.some(item => typeof item !== 'string'))) {
                throw new InformAiError(`Invalid enum for ${location}.${key}. Supply string values.`);
            }
            if (field.type === 'object[]') this.validateSchema(`${location}.${key}[]`, field.elementSchema!);
        }
    }

    private validateObject(location: string, schema: Readonly<Record<string, FieldDef>>, value: ConfigObject): string[] {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return [`${location} must be an explicitly configured object.`];
        const errors: string[] = [];
        for (const key of Object.keys(value)) if (!Object.hasOwn(schema, key)) errors.push(`${location}.${key} is unknown. Use a field declared by its owner.`);
        for (const [key, field] of Object.entries(schema)) {
            const entry = Object.hasOwn(value, key) ? value[key] : undefined, label = `${location}.${key}`;
            if (entry === undefined) {
                if (!field.optional) errors.push(`${label} is required. Add an explicit ${field.type} value.`);
                continue;
            }
            if (entry === null && field.nullable) continue;
            const valid = field.type.endsWith('[]') ? Array.isArray(entry) : typeof entry === field.type;
            if (!valid || entry === null) { errors.push(`${label} must be ${field.type}.`); continue; }
            if (field.enumValues && !field.enumValues.includes(String(entry))) errors.push(`${label} must be one of ${field.enumValues.join(', ')}.`);
            if (Array.isArray(entry)) {
                if (field.nonEmpty && entry.length === 0) errors.push(`${label} must contain at least one entry.`);
                if (field.type === 'string[]' && entry.some(item => typeof item !== 'string')) errors.push(`${label} must contain only strings.`);
                if (field.type === 'object[]') entry.forEach((item, index) => errors.push(...this.validateObject(`${label}[${index}]`, field.elementSchema!, item as ConfigObject)));
            }
        }
        return errors;
    }
}

/** Inject the selected module transport; discovery never names a built-in owner package. */
@injectable(bindingScopeValues.Singleton)
export class RulePackDiscovery {
    constructor(private readonly loader: RulePackModuleLoader) {}

    discover(declarations: readonly RulePackDeclaration[]): RulePackRegistry {
        return new RulePackRegistry(declarations.map(declaration => this.loader.load(declaration.module)));
    }
}
