import { injectable, bindingScopeValues } from 'inversify';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { RulePackManifest, ConfigObject, RetiredConfigKey } from '@webpieces/rules-sdk';
import { InformAiError } from '@webpieces/tooling-common';
import { toError } from '@webpieces/tooling-common/to-error';
import { NodeRulePackModuleLoader, RulePackRegistry } from './rule-pack-registry';
import { RepositoryPath } from './repository-path';
import { retiredKeyError, RETIRED_SCOPE_RULE } from './retired-config-keys';
import { formatConfigErrorsBanner } from './config-error-banner';

/** The root declaration identifies an exact package/module and its owner-specific config file. */
export class PackPolicyDeclaration {
    readonly package: string;

    constructor(
        packageName: string,
        readonly config: string,
    ) {
        this.package = packageName;
    }

    moduleName(): string {
        return /\.(?:cjs|mjs|js)$/.test(this.package) ? this.package : `${this.package}/rule-pack`;
    }
}

export class SelectedPolicyPack {
    constructor(
        readonly declaration: PackPolicyDeclaration,
        readonly manifest: RulePackManifest,
    ) {}
}

export class PackPolicyFilesResult {
    constructor(
        readonly registry: RulePackRegistry,
        readonly selected: readonly SelectedPolicyPack[],
        readonly values: Record<string, ConfigObject>,
        readonly targetFiles: ReadonlyMap<string, string>,
    ) {}
}

/** Configuration belongs to explicitly selected owners; loading never supplies recommended seeds. */
@injectable(bindingScopeValues.Singleton)
export class PackPolicyFiles {
    // webpieces-disable no-any-unknown -- root JSON is narrowed before resolving modules or files.
    declarations(raw: unknown, root: string): PackPolicyDeclaration[] {
        if (!Array.isArray(raw) || raw.length === 0) {
            throw new InformAiError(
                'webpieces.config.json.rulePacks is required. Run pnpm wp-rules-sync --upgrade to split the existing explicit config, or add exact {"package":"<pack>","config":".webpieces/rules/<pack>.json"} declarations.',
            );
        }
        const packages = new Set<string>(),
            files = new Set<string>();
        // webpieces-disable no-any-unknown -- external JSON or runtime exports are validated before policy execution
        return raw.map((entry: unknown) => {
            if (
                !entry ||
                typeof entry !== 'object' ||
                Array.isArray(entry) ||
                !('package' in entry) ||
                !('config' in entry) ||
                typeof entry.package !== 'string' ||
                !entry.package ||
                typeof entry.config !== 'string' ||
                !entry.config ||
                Object.keys(entry).some((key: string) => !['package', 'config'].includes(key))
            ) {
                throw new InformAiError(
                    'Invalid rulePacks entry in webpieces.config.json. Supply exactly package and config strings.',
                );
            }
            const filename = this.configPath(root, entry.config);
            if (packages.has(entry.package) || files.has(filename)) {
                throw new InformAiError(
                    `Duplicate rule-pack declaration or config path: ${entry.package}, ${entry.config}. Declare each pack and config once.`,
                );
            }
            packages.add(entry.package);
            files.add(filename);
            return new PackPolicyDeclaration(entry.package, entry.config);
        });
    }

    select(root: string, declarations: readonly PackPolicyDeclaration[]): SelectedPolicyPack[] {
        const loader = new NodeRulePackModuleLoader(root);
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- module failures identify the declaration's actual repair file.
        try {
            return declarations.map((declaration: PackPolicyDeclaration) => {
                const manifest = loader.load(declaration.moduleName());
                if (
                    declaration.moduleName() === `${declaration.package}/rule-pack` &&
                    manifest.packageName !== declaration.package
                ) {
                    throw new InformAiError(
                        `Declared package ${declaration.package} exports owner ${manifest.packageName}. Declare the actual owning package or an explicit client manifest module.`,
                    );
                }
                return new SelectedPolicyPack(declaration, manifest);
            });
        // webpieces-disable no-any-unknown -- external JSON or runtime exports are validated before policy execution
        } catch (err: unknown) {
            const error = toError(err);
            throw new InformAiError(
                `Rule-pack selection in ${path.join(root, 'webpieces.config.json')} needs repair: ${error.message}`,
                { cause: error },
            );
        }
    }

    resolve(root: string, selected: readonly SelectedPolicyPack[]): PackPolicyFilesResult {
        const registry = new RulePackRegistry(
            selected.map((pack: SelectedPolicyPack) => pack.manifest),
        );
        for (const pack of selected)
            registry.recordModuleLocation(pack.manifest.packageName, pack.declaration.moduleName());
        const values: Record<string, ConfigObject> = {},
            targetFiles = new Map<string, string>();
        const errors: string[] = [];
        for (const pack of selected) {
            const filename = this.configPath(root, pack.declaration.config);
            for (const definition of pack.manifest.ownedRules)
                targetFiles.set(definition.id, filename);
        }
        for (const pack of selected) {
            const filename = this.configPath(root, pack.declaration.config);
            const entries = this.read(filename);
            for (const id of Object.keys(entries)) {
                if (!registry.hasRule(id)) {
                    const retired = registry
                        .migrations()
                        .find(
                            (entry: RetiredConfigKey) =>
                                entry.scope === RETIRED_SCOPE_RULE && entry.key === id,
                        );
                    errors.push(
                        `${filename}: ${retired ? retiredKeyError(retired) : `${id} has no declared configurable owner. Remove this entry.`}`,
                    );
                } else if (registry.ownerOf(id) !== pack.manifest.packageName) {
                    errors.push(
                        `${filename}: ${id} belongs to ${registry.ownerOf(id)}. Move it to ${targetFiles.get(id)}.`,
                    );
                }
            }
            for (const definition of pack.manifest.ownedRules) {
                if (!Object.hasOwn(entries, definition.id)) {
                    errors.push(
                        `${filename}: missing required entry ${definition.id}. Run pnpm wp-rules-sync to write its owner seed and review it, or configure it explicitly; OFF still requires every required field.`,
                    );
                    continue;
                }
                const value = entries[definition.id];
                errors.push(
                    ...registry
                        .validateRuleConfig(definition.id, value)
                        .map((error: string) => `${filename}: ${error}`),
                );
                values[definition.id] = value;
            }
        }
        if (errors.length) {
            throw new InformAiError(
                formatConfigErrorsBanner(errors).replace(
                    'THE FIX: edit webpieces.config.json',
                    'THE FIX: edit declared owner config files',
                ) +
                    '\nEditing webpieces.config.json and the named owner files is ALWAYS allowed. Missing required settings can be written explicitly with pnpm wp-rules-sync; review and commit the diff. Required settings are never supplied during loading.',
            );
        }
        return new PackPolicyFilesResult(registry, selected, values, targetFiles);
    }

    configPath(root: string, relative: string): string {
        if (path.isAbsolute(relative) || !relative.endsWith('.json')) {
            throw new InformAiError(
                `Invalid pack config path ${relative}. Use a distinct repository-relative JSON file.`,
            );
        }
        let target: string;
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- path faults name the declaration that needs repair
        try {
            target = new RepositoryPath(root).resolve(relative);
        // webpieces-disable no-any-unknown -- external JSON or runtime exports are validated before policy execution
        } catch (err: unknown) {
            const error = toError(err);
            throw new InformAiError(`Invalid pack config path ${relative}: ${error.message}`, {
                cause: error,
            });
        }
        const normalized = path.relative(fs.realpathSync(root), target);
        if (
            path.isAbsolute(relative) ||
            normalized.startsWith('..') ||
            !normalized.endsWith('.json') ||
            normalized === 'webpieces.config.json' ||
            normalized === '.webpieces/rules.lock.json'
        ) {
            throw new InformAiError(
                `Invalid pack config path ${relative}. Use a distinct repository-relative JSON path such as .webpieces/rules/code.json.`,
            );
        }
        return target;
    }

    read(filename: string): Record<string, ConfigObject> {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- malformed or absent pack files name their exact repair path.
        try {
            if (!fs.existsSync(filename)) {
                throw new InformAiError(
                    `Missing rule-pack config ${filename}. Run pnpm wp-rules-sync to create explicit owner seeds, then review the diff.`,
                );
            }
            // webpieces-disable no-any-unknown -- registry validation narrows the parsed option bags.
            const entries: unknown = JSON.parse(fs.readFileSync(filename, 'utf8'));
            if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
                throw new InformAiError(
                    `${filename} must be an object mapping owned rule IDs to explicit config objects.`,
                );
            }
            return entries as Record<string, ConfigObject>;
        // webpieces-disable no-any-unknown -- external JSON or runtime exports are validated before policy execution
        } catch (err: unknown) {
            const error = toError(err);
            if (error instanceof InformAiError) throw error;
            throw new InformAiError(
                `Cannot parse rule-pack config ${filename}: ${error.message}. Edit this file to restore valid JSON.`,
                { cause: error },
            );
        }
    }
}
