import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadAndValidate, RuleFailError, Option } from '@webpieces/rules-config';
import { InformAiError } from '@webpieces/tooling-common';
import { BuildPolicyResult } from '@webpieces/rules-sdk';
import { DependencyWorkspace, DependencyOwner, DependencyManifest } from './dependency-workspace';
import { DependencyImports, DependencyImport } from './dependency-imports';
import { RuleGate } from './rule-gate';

const SECTIONS = [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
    'peerDependencies',
] as const;
const EXACT =
    /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

class CompilerAliases {
    paths?: Record<string, string[]>;
}

class AliasFile {
    compilerOptions?: CompilerAliases;
}

class StyleAsset {
    input?: string;
}

class BuildAssets {
    styles?: (string | StyleAsset)[];
    polyfills?: string[];
}

class BuildTarget {
    options?: BuildAssets;
}

class ProjectAssets {
    targets?: Record<string, BuildTarget>;
}

export class DependencyVersion {
    isExact(version: string): boolean {
        return EXACT.test(version);
    }
}

export class DependencyPolicyOptions {
    // Every choice is supplied by the owning repository, never defaulted by a rule.
    constructor(
        readonly catalog: boolean,
        readonly freeze: boolean,
        readonly ownership: boolean,
        readonly allowedNames: string[],
        readonly rootToolPaths: string[],
        readonly testPaths: string[],
        readonly artifactProbePaths: string[],
        readonly toolProviders: string[],
        readonly dynamicImports: string[],
    ) {}
}

/** The public workspace feature: declarations, catalogue, and source ownership share one scan. */
export class DependencyPolicies {
    private readonly imports = new DependencyImports();
    private readonly version = new DependencyVersion();
    private readonly aliases = new Map<string, AliasFile>();

    validate(root: string, options: DependencyPolicyOptions): string[] {
        const workspace = new DependencyWorkspace(root);
        const errors: string[] = [];
        const catalogue: string[] = [];
        const freeze: string[] = [];
        const ownership: string[] = [];
        if (options.catalog) this.catalog(workspace, catalogue);
        if (options.freeze) this.freeze(workspace, options, freeze);
        if (options.ownership) this.ownership(workspace, options, ownership);
        errors.push(...catalogue.map((message: string) => `[dependency-catalog] ${message}`));
        errors.push(...freeze.map((message: string) => `[root-runtime-freeze] ${message}`));
        errors.push(...ownership.map((message: string) => `[dependency-ownership] ${message}`));
        return [...new Set(errors)].sort();
    }

    enforce(root: string, options: DependencyPolicyOptions): BuildPolicyResult {
        const errors = this.validate(root, options);
        if (errors.length) {
            const firstRule = errors[0].slice(1, errors[0].indexOf(']'));
            throw new RuleFailError(firstRule, errors.join('\n'), undefined, undefined, [
                new Option(
                    'Repair each named importing owner or reviewed policy entry; keep runtime names local and direct versions in the catalogue',
                    true,
                ),
            ]);
        }
        return new BuildPolicyResult(true);
    }

    private catalog(workspace: DependencyWorkspace, errors: string[]): void {
        const owners = [new DependencyOwner('.', workspace.rootManifest), ...workspace.owners];
        for (const owner of owners) {
            if (!owner.manifest) continue;
            for (const section of SECTIONS) {
                for (const declaration of Object.entries(owner.manifest[section] ?? {})) {
                    const name = declaration[0];
                    const specifier = declaration[1];
                    const where = `${owner.directory}/package.json ${section}.${name}`;
                    if (specifier === 'workspace:*') {
                        if (
                            !workspace.owners.some(
                                (entry: DependencyOwner) => entry.manifest?.name === name,
                            )
                        )
                            errors.push(
                                `${where}: workspace:* must name a managed workspace owner`,
                            );
                        continue;
                    }
                    if (!specifier.startsWith('catalog:')) {
                        errors.push(
                            `${where}: use catalog: with an exact centrally owned version (found ${specifier})`,
                        );
                        continue;
                    }
                    const catalogName = specifier.slice('catalog:'.length);
                    const pins = catalogName
                        ? workspace.catalog.catalogs?.[catalogName]
                        : workspace.catalog.catalog;
                    const pin = pins?.[name];
                    if (typeof pin !== 'string' || !this.version.isExact(pin))
                        errors.push(
                            `${where}: ${specifier} must resolve to an exact version in pnpm-workspace.yaml (found ${String(pin)})`,
                        );
                }
            }
        }
    }

    private freeze(
        workspace: DependencyWorkspace,
        options: DependencyPolicyOptions,
        errors: string[],
    ): void {
        for (const section of [
            'dependencies',
            'optionalDependencies',
            'peerDependencies',
        ] as const) {
            for (const name of Object.keys(workspace.rootManifest[section] ?? {})) {
                if (!options.allowedNames.includes(name))
                    errors.push(
                        `package.json ${section}.${name}: new root runtime name; declare it in the consuming module instead, or review the committed root-runtime-freeze baseline`,
                    );
            }
        }
    }

    private ownership(
        workspace: DependencyWorkspace,
        options: DependencyPolicyOptions,
        errors: string[],
    ): void {
        for (const file of workspace.files) {
            if (file.endsWith('/project.json')) this.assets(workspace, options, file, errors);
            if (!/\.[cm]?[jt]sx?$/u.test(file) || file.endsWith('.d.ts')) continue;
            if (workspace.matches(file, options.artifactProbePaths)) continue;
            const owner = workspace.owner(file);
            const isTool = workspace.matches(file, options.rootToolPaths);
            const text = fs.readFileSync(path.join(workspace.root, file), 'utf8');
            for (const entry of this.imports.read(text, file)) {
                if (entry.unresolved) {
                    this.dynamic(workspace, options, owner, file, entry, isTool, errors);
                    continue;
                }
                this.declaration(workspace, options, owner, file, entry, isTool, errors);
            }
        }
    }

    private dynamic(
        workspace: DependencyWorkspace,
        options: DependencyPolicyOptions,
        owner: DependencyOwner,
        file: string,
        entry: DependencyImport,
        isTool: boolean,
        errors: string[],
    ): void {
        const expression = entry.unresolved.replace(/\s+/gu, ' ').trim();
        const key = `${file}::${expression}::`;
        const reviewed = options.dynamicImports.find((item: string) => item.startsWith(key));
        if (reviewed === undefined) {
            errors.push(
                `${file}:${entry.line}: unclassified dependency expression ${expression}; review its actual package names and declare the exact file::expression::package-list mapping in dependency-ownership.dynamicImports (empty package-list only for a verified local/artifact expression)`,
            );
            return;
        }
        for (const specifier of reviewed.slice(key.length).split(',').filter(Boolean))
            this.declaration(
                workspace,
                options,
                owner,
                file,
                new DependencyImport(specifier, entry.line, entry.runtime),
                isTool,
                errors,
            );
    }

    private assets(
        workspace: DependencyWorkspace,
        options: DependencyPolicyOptions,
        file: string,
        errors: string[],
    ): void {
        const project = JSON.parse(
            fs.readFileSync(path.join(workspace.root, file), 'utf8'),
        ) as ProjectAssets;
        const build = project.targets?.['build']?.options;
        const names = [...(build?.polyfills ?? [])];
        for (const asset of build?.styles ?? []) {
            const input = typeof asset === 'string' ? asset : asset.input;
            if (input?.startsWith('node_modules/')) names.push(input.slice('node_modules/'.length));
        }
        for (const name of names)
            this.declaration(
                workspace,
                options,
                workspace.owner(file),
                file,
                new DependencyImport(name, 1, true),
                false,
                errors,
            );
    }

    private declaration(
        workspace: DependencyWorkspace,
        options: DependencyPolicyOptions,
        owner: DependencyOwner,
        file: string,
        entry: DependencyImport,
        isTool: boolean,
        errors: string[],
    ): void {
        const name = this.name(workspace, owner, entry.specifier);
        if (!name || name === owner.manifest?.name) return;
        if (
            isTool &&
            (owner.manifest?.dependencies?.[name] ||
                owner.manifest?.devDependencies?.[name] ||
                owner.manifest?.optionalDependencies?.[name] ||
                owner.manifest?.peerDependencies?.[name])
        )
            return;
        const declared = isTool ? workspace.rootManifest : owner.manifest;
        if (!declared) {
            errors.push(
                `${file}:${entry.line}: ${entry.specifier} has no importing manifest; create an owner manifest or explicitly classify this tool file`,
            );
            return;
        }
        const isTest =
            workspace.matches(file, options.testPaths) ||
            /(?:^|\/)(?:tests?|__tests__|__mocks__|__fixtures__|e2e)(?:\/|$)|\.(?:spec|test|spec-support|test-support)\.[cm]?[jt]sx?$/u.test(
                file,
            );
        const publicDeclaration = Boolean(owner.manifest?.types && owner.manifest.private !== true);
        const runtime = (entry.runtime || publicDeclaration) && !isTest && !isTool;
        const present =
            declared.dependencies?.[name] ||
            declared.optionalDependencies?.[name] ||
            declared.peerDependencies?.[name] ||
            (!runtime && declared.devDependencies?.[name]);
        if (present || (isTool && this.provided(declared, options.toolProviders, name))) return;
        const section = runtime ? 'dependencies' : 'devDependencies';
        errors.push(
            `${file}:${entry.line}: ${name} must be declared in ${isTool ? '.' : owner.directory}/package.json ${section}; root/other-owner hoisting cannot satisfy this import`,
        );
    }

    private provided(
        manifest: DependencyManifest,
        providers: readonly string[],
        name: string,
    ): boolean {
        return providers.some((entry: string) => {
            const separator = entry.indexOf('=');
            return (
                separator > 0 &&
                entry.slice(0, separator) === name &&
                Boolean(manifest.devDependencies?.[entry.slice(separator + 1)])
            );
        });
    }

    private name(
        workspace: DependencyWorkspace,
        owner: DependencyOwner,
        specifier: string,
    ): string | undefined {
        const raw = this.imports.packageName(specifier);
        if (!raw) return undefined;
        if (specifier.startsWith('app/') && owner.directory.startsWith('services/'))
            return owner.manifest?.name;
        const config = path.join(workspace.root, 'tsconfig.base.json');
        if (!fs.existsSync(config)) return raw;
        let json = this.aliases.get(workspace.root);
        if (!json) {
            json = JSON.parse(fs.readFileSync(config, 'utf8')) as AliasFile;
            this.aliases.set(workspace.root, json);
        }
        for (const mapping of Object.entries(json.compilerOptions?.paths ?? {})) {
            const alias = mapping[0];
            const targets = mapping[1];
            const prefix = alias.endsWith('*') ? alias.slice(0, -1) : alias;
            if (alias.endsWith('*') ? specifier.startsWith(prefix) : specifier === alias) {
                const target = targets[0]?.replace('*', specifier.slice(prefix.length));
                if (target) return workspace.owner(target).manifest?.name ?? raw;
            }
        }
        return raw;
    }
}

export class ConfiguredDependencyPolicies {
    run(root: string): BuildPolicyResult {
        const rules = loadAndValidate(root).resolved.rules;
        const catalog = rules.get('dependency-catalog');
        const freeze = rules.get('root-runtime-freeze');
        const ownership = rules.get('dependency-ownership');
        if (!catalog || !freeze || !ownership)
            throw new InformAiError('Declare all three dependency policies in their owning pack');
        const list = (rule: typeof freeze, field: string): string[] => {
            const value = rule.options[field] as string[];
            if (!Array.isArray(value) || value.some((item: string) => typeof item !== 'string'))
                throw new InformAiError(
                    `Explicit dependency policy field ${field} must be a string array`,
                );
            return value as string[];
        };
        const gate = new RuleGate();
        const options = new DependencyPolicyOptions(
            !gate.isDisabled(root, 'dependency-catalog', true),
            !gate.isDisabled(root, 'root-runtime-freeze', true),
            !gate.isDisabled(root, 'dependency-ownership', true),
            list(freeze, 'allowedNames'),
            list(ownership, 'rootToolPaths'),
            list(ownership, 'testPaths'),
            list(ownership, 'artifactProbePaths'),
            list(ownership, 'toolProviders'),
            list(ownership, 'dynamicImports'),
        );
        return new DependencyPolicies().enforce(root, options);
    }
}
