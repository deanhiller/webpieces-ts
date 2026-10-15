import { injectable, bindingScopeValues } from 'inversify';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { RulePackManifest, ConfigObject, RetiredConfigKey, OwnedRuleDefinition } from '@webpieces/rules-sdk';
import { InformAiError, RepositoryLayout } from '@webpieces/tooling-common';
import { toError } from '@webpieces/tooling-common/to-error';
import { NodeRulePackModuleLoader, RulePackRegistry } from './rule-pack-registry';
import { RepositoryPath } from './repository-path';
import { retiredKeyError, RETIRED_SCOPE_RULE } from './retired-config-keys';
import { formatConfigErrorsBanner } from './config-error-banner';
import { ConfigRepairError, EditFileCure, RepositoryLayoutRepair, RunCommandCure } from './config-repair-error';
import { CONFIG_FILENAME } from './config-file';

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

/**
 * Configuration belongs to explicitly selected owners; loading never supplies recommended seeds.
 *
 * Every problem this class finds is a ConfigRepairError naming the file to edit and the exact entry to
 * paste or delete (#1273). The hooks permit those edits while the config is invalid, so an upgrade that
 * adds a required rule costs the agent one edit of one named file, and no command.
 */
@injectable(bindingScopeValues.Singleton)
export class PackPolicyFiles {
    // webpieces-disable no-any-unknown -- root JSON is narrowed before resolving modules or files.
    declarations(raw: unknown, root: string): PackPolicyDeclaration[] {
        const rootFile = path.join(root, CONFIG_FILENAME);
        if (!Array.isArray(raw) || raw.length === 0) {
            throw new ConfigRepairError(`${rootFile}: rulePacks is required.`, [
                new EditFileCure(
                    rootFile,
                    'Add "rulePacks": [{"package":"<pack>","config":".webpieces-config/rules/<pack>.json"}, ...] with one declaration per selected rule pack; each rule then names the owner file its entry belongs in.',
                ),
            ]);
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
                throw new ConfigRepairError(
                    `${rootFile}: invalid rulePacks entry ${JSON.stringify(entry)}.`,
                    [
                        new EditFileCure(
                            rootFile,
                            'Give the entry exactly two string fields: {"package":"<pack>","config":".webpieces-config/rules/<pack>.json"}.',
                        ),
                    ],
                );
            }
            const filename = this.configPath(root, entry.config);
            if (packages.has(entry.package) || files.has(filename)) {
                throw new ConfigRepairError(
                    `${rootFile}: duplicate rule-pack declaration or config path: ${entry.package}, ${entry.config}.`,
                    [
                        new EditFileCure(
                            rootFile,
                            'Delete the second rulePacks entry; declare each pack and config once.',
                        ),
                    ],
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
            const rootFile = path.join(root, CONFIG_FILENAME);
            throw new ConfigRepairError(
                `Rule-pack selection in ${rootFile} needs repair: ${error.message}`,
                [
                    new EditFileCure(
                        rootFile,
                        'Fix the rulePacks entry named above: declare the package that actually owns the pack, or delete the entry.',
                    ),
                    new RunCommandCure(
                        'pnpm install',
                        'pnpm install — when the declared pack is simply missing from node_modules.',
                    ),
                ],
                { cause: error },
            );
        }
    }

    resolve(root: string, selected: readonly SelectedPolicyPack[]): PackPolicyFilesResult {
        const registry = this.registry(root, selected);
        const values: Record<string, ConfigObject> = {},
            targetFiles = new Map<string, string>();
        const errors: string[] = [];
        const filesToEdit = new Set<string>();
        for (const pack of selected) {
            const filename = this.configPath(root, pack.declaration.config);
            for (const definition of pack.manifest.ownedRules)
                targetFiles.set(definition.id, filename);
        }
        for (const pack of selected) {
            const filename = this.configPath(root, pack.declaration.config);
            if (!fs.existsSync(filename)) {
                filesToEdit.add(filename);
                errors.push(
                    `${filename}: missing rule-pack config for ${pack.manifest.packageName}. Create it with this content (the owner's recommended seeds — review every value):\n${JSON.stringify(this.seeds(pack), null, 2)}`,
                );
                continue;
            }
            const entries = this.read(filename);
            this.foreignEntries(filename, entries, pack, registry, targetFiles, errors, filesToEdit);
            for (const definition of pack.manifest.ownedRules) {
                if (!Object.hasOwn(entries, definition.id)) {
                    filesToEdit.add(filename);
                    errors.push(
                        `${filename}: missing required entry "${definition.id}". Paste this entry into that file (the owner's recommended seed — choose your own values; OFF still states every required field):\n"${definition.id}": ${JSON.stringify(registry.seedFor(definition.id))}`,
                    );
                    continue;
                }
                const value = entries[definition.id];
                const invalid = registry
                    .validateRuleConfig(definition.id, value)
                    .map((error: string) => `${filename}: ${error}`);
                if (invalid.length) filesToEdit.add(filename);
                errors.push(...invalid);
                values[definition.id] = value;
            }
        }
        if (errors.length) {
            throw new ConfigRepairError(
                formatConfigErrorsBanner(errors).replace(
                    'THE FIX: edit webpieces.config.json',
                    'THE FIX: edit the declared owner config files named above',
                ) +
                    '\nEditing webpieces.config.json and every file under .webpieces-config/ is ALWAYS allowed, even while the config is invalid. Required settings are never supplied during loading.',
                [...filesToEdit].map((file: string) =>
                    new EditFileCure(file, `Edit ${file} and apply every bullet above that names it.`),
                ),
            );
        }
        return new PackPolicyFilesResult(registry, selected, values, targetFiles);
    }

    configPath(root: string, relative: string): string {
        const rootFile = path.join(root, CONFIG_FILENAME);
        const fixPath = new EditFileCure(
            rootFile,
            `Change the rulePacks config "${relative}" to a distinct repository-relative JSON path such as .webpieces-config/rules/code.json.`,
        );
        if (path.isAbsolute(relative) || !relative.endsWith('.json')) {
            throw new ConfigRepairError(`${rootFile}: invalid pack config path ${relative}.`, [fixPath]);
        }
        let target: string;
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- path faults name the declaration that needs repair
        try {
            target = new RepositoryPath(root).resolve(relative);
            // webpieces-disable no-any-unknown -- external JSON or runtime exports are validated before policy execution
        } catch (err: unknown) {
            const error = toError(err);
            throw new ConfigRepairError(
                `${rootFile}: invalid pack config path ${relative}: ${error.message}`,
                [fixPath],
                { cause: error },
            );
        }
        const normalized = path.relative(fs.realpathSync(root), target);
        if (
            path.isAbsolute(relative) ||
            normalized.startsWith('..') ||
            !normalized.endsWith('.json') ||
            normalized === CONFIG_FILENAME
        ) {
            throw new ConfigRepairError(`${rootFile}: invalid pack config path ${relative}.`, [fixPath]);
        }
        new RepositoryLayoutRepair().run(() => new RepositoryLayout().assertPolicyPath(normalized));
        return target;
    }

    read(filename: string): Record<string, ConfigObject> {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- malformed pack files name their exact repair path.
        try {
            // webpieces-disable no-any-unknown -- registry validation narrows the parsed option bags.
            const entries: unknown = JSON.parse(fs.readFileSync(filename, 'utf8'));
            if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
                throw new ConfigRepairError(
                    `${filename} must be an object mapping owned rule IDs to explicit config objects.`,
                    [
                        new EditFileCure(
                            filename,
                            `Rewrite ${filename} as one JSON object: {"<rule-id>": {...}, ...}.`,
                        ),
                    ],
                );
            }
            return entries as Record<string, ConfigObject>;
            // webpieces-disable no-any-unknown -- external JSON or runtime exports are validated before policy execution
        } catch (err: unknown) {
            const error = toError(err);
            if (error instanceof InformAiError) throw error;
            throw new ConfigRepairError(
                `Cannot parse rule-pack config ${filename}: ${error.message}.`,
                [new EditFileCure(filename, `Edit ${filename} to restore valid JSON.`)],
                { cause: error },
            );
        }
    }

    // Entries this owner file must not hold: unknown or retired IDs (delete), and another owner's (move).
    // eslint-disable-next-line @typescript-eslint/max-params -- the accumulators of resolve(), passed through once
    private foreignEntries(
        filename: string,
        entries: Record<string, ConfigObject>,
        pack: SelectedPolicyPack,
        registry: RulePackRegistry,
        targetFiles: ReadonlyMap<string, string>,
        errors: string[],
        filesToEdit: Set<string>,
    ): void {
        for (const id of Object.keys(entries)) {
            if (!registry.hasRule(id)) {
                const retired = registry
                    .migrations()
                    .find(
                        (entry: RetiredConfigKey) =>
                            entry.scope === RETIRED_SCOPE_RULE && entry.key === id,
                    );
                filesToEdit.add(filename);
                errors.push(
                    `${filename}: ${retired ? retiredKeyError(retired) : `"${id}" has no declared configurable owner. Delete the "${id}" entry from this file.`}`,
                );
            } else if (registry.ownerOf(id) !== pack.manifest.packageName) {
                const owner = targetFiles.get(id) ?? '';
                filesToEdit.add(filename);
                filesToEdit.add(owner);
                errors.push(
                    `${filename}: "${id}" belongs to ${registry.ownerOf(id)}. Delete the "${id}" entry here and paste it into ${owner}.`,
                );
            }
        }
    }

    // Conflicting manifests (two packs owning one rule) are a SELECTION problem: the declaration is the fix.
    private registry(root: string, selected: readonly SelectedPolicyPack[]): RulePackRegistry {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- converts a manifest conflict into the declaration's structured repair
        try {
            const registry = new RulePackRegistry(
                selected.map((pack: SelectedPolicyPack) => pack.manifest),
            );
            for (const pack of selected)
                registry.recordModuleLocation(pack.manifest.packageName, pack.declaration.moduleName());
            return registry;
            // webpieces-disable no-any-unknown -- external JSON or runtime exports are validated before policy execution
        } catch (err: unknown) {
            const error = toError(err);
            if (!(error instanceof InformAiError)) throw error;
            const rootFile = path.join(root, CONFIG_FILENAME);
            throw new ConfigRepairError(
                `The rule packs declared in ${rootFile} conflict: ${error.message}`,
                [new EditFileCure(rootFile, 'Delete one of the conflicting rulePacks declarations.')],
                { cause: error },
            );
        }
    }

    // The exact owner file a missing declaration needs: every owned rule's recommended seed, for review.
    private seeds(pack: SelectedPolicyPack): Record<string, ConfigObject> {
        return Object.fromEntries(
            pack.manifest.ownedRules.map((definition: OwnedRuleDefinition) => [
                definition.id,
                structuredClone(definition.recommendedSeed),
            ]),
        );
    }
}
