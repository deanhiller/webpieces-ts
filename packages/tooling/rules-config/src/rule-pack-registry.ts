import { injectable, bindingScopeValues } from 'inversify';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import {
    FieldDef, RulePackManifest, RulePackDeclaration, OwnedRuleDefinition,
    RULE_PACK_API_VERSION, RULE_SCHEMA_API_VERSION, ConfigObject,
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
            throw new Error(`Rule pack ${moduleName} must export rulePackManifest. Add the public manifest export.`);
        }
        return exports.rulePackManifest as RulePackManifest;
    }
}

/** A registry depends only on declarations and the SDK, never on concrete execution packages. */
export class RulePackRegistry {
    private readonly owners = new Map<string, string>();
    private readonly definitions = new Map<string, OwnedRuleDefinition>();

    constructor(readonly manifests: readonly RulePackManifest[]) {
        const packs = new Set<string>();
        for (const manifest of manifests) {
            this.validateManifest(manifest);
            if (packs.has(manifest.packageName)) throw new Error(`Duplicate pack ${manifest.packageName}. Declare it once.`);
            packs.add(manifest.packageName);
            for (const definition of manifest.ownedRules) {
                if (this.owners.has(definition.id)) throw new Error(`Rule ${definition.id} has multiple owners. Keep exactly one owner.`);
                this.owners.set(definition.id, manifest.packageName);
                this.definitions.set(definition.id, definition);
            }
        }
        const executions = new Set<string>();
        for (const manifest of manifests) {
            for (const contribution of manifest.contributions) {
                if (!contribution || typeof contribution.ruleId !== 'string' || typeof contribution.ownerPack !== 'string') {
                    throw new Error(`Invalid contribution in ${manifest.packageName}. Supply ruleId and ownerPack.`);
                }
                const owner = this.owners.get(contribution.ruleId);
                if (!owner || owner !== contribution.ownerPack) {
                    throw new Error(`Unknown owner ${contribution.ownerPack} for ${contribution.ruleId}. Declare the owning pack and use its exact name.`);
                }
                if (!['build', 'source-hook', 'workflow-guard', 'lint'].includes(contribution.executionKind)) {
                    throw new Error(`Invalid execution kind for ${contribution.ruleId}. Use build, source-hook, workflow-guard, or lint.`);
                }
                const execution = `${contribution.ruleId}:${contribution.executionKind}`;
                if (executions.has(execution)) throw new Error(`Duplicate execution-kind contribution ${execution}. Keep one implementation per execution kind.`);
                executions.add(execution);
            }
        }
    }

    ownerOf(ruleId: string): string {
        const owner = this.owners.get(ruleId);
        if (!owner) throw new Error(`Unknown rule ${ruleId}. Declare its owning pack.`);
        return owner;
    }

    schemaFor(ruleId: string): Readonly<Record<string, FieldDef>> {
        this.ownerOf(ruleId);
        return this.definitions.get(ruleId)!.schema;
    }

    ruleIds(): readonly string[] {
        return [...this.definitions.keys()];
    }

    /** Validates explicit config values with the owner's schema; supplies no rule defaults. */
    validateRuleConfig(ruleId: string, value: ConfigObject): readonly string[] {
        return this.validateObject(ruleId, this.schemaFor(ruleId), value);
    }

    private validateManifest(manifest: RulePackManifest): void {
        if (!manifest || typeof manifest.packageName !== 'string' || manifest.packageName.length === 0 ||
            typeof manifest.packageVersion !== 'string' || manifest.packageVersion.length === 0 ||
            !Array.isArray(manifest.ownedRules) || !Array.isArray(manifest.contributions)) {
            throw new Error('Invalid rule pack manifest. Supply packageName, packageVersion, ownedRules, and contributions.');
        }
        if (manifest.apiVersion !== RULE_PACK_API_VERSION) {
            throw new Error(`Unsupported manifest API ${manifest.apiVersion} for ${manifest.packageName}. Use API ${RULE_PACK_API_VERSION}.`);
        }
        for (const definition of manifest.ownedRules) {
            if (!definition || typeof definition.id !== 'string' || definition.id.length === 0) {
                throw new Error(`Invalid owned rule in ${manifest.packageName}. Supply a nonempty id.`);
            }
            if (definition.schemaApiVersion !== RULE_SCHEMA_API_VERSION) {
                throw new Error(`Unsupported schema API for ${definition.id}. Use API ${RULE_SCHEMA_API_VERSION}.`);
            }
            this.validateSchema(definition.id, definition.schema);
        }
    }

    private validateSchema(location: string, schema: Readonly<Record<string, FieldDef>>): void {
        if (!schema || typeof schema !== 'object' || Array.isArray(schema)) throw new Error(`Invalid schema for ${location}. Supply a field map.`);
        for (const [key, field] of Object.entries(schema)) {
            if (!field || !['string', 'number', 'boolean', 'string[]', 'object[]'].includes(field.type)) {
                throw new Error(`Invalid field ${location}.${key}. Supply a supported FieldDef type.`);
            }
            for (const flag of ['optional', 'nullable', 'nonEmpty'] as const) {
                if (field[flag] !== undefined && typeof field[flag] !== 'boolean') throw new Error(`Invalid ${flag} for ${location}.${key}. Supply a boolean.`);
            }
            if (field.enumValues !== undefined && (!Array.isArray(field.enumValues) || field.enumValues.some(item => typeof item !== 'string'))) {
                throw new Error(`Invalid enum for ${location}.${key}. Supply string values.`);
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
