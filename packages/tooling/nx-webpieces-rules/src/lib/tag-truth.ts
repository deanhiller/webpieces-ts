/**
 * Tag truth — the four GRAPH rules that make an nx `role:*` / `framework:*` / `product:*` tag true
 * (#1064, #1179):
 *
 *   api-lib-dependencies (D2) — a `role:api-lib` depends only on other `role:api-lib` projects plus a
 *                               stated list of outside packages; a `role:api-client` may also import
 *                               the packages its own config entry names (its SDK, inversify, …).
 *   api-lib-path         (D10) — every api-lib / api-client lives under the configured api globs, and
 *                               everything under them carries one of those two roles.
 *   framework-folder     (D9) — the folder a library lives in and its framework set + role agree,
 *                               both directions.
 *   product-tags      (#1179) — every project whose role is listed (seed: server, client, app)
 *                               carries a well-formed `product:<name>` tag, the seed the product
 *                               filter and Product color mode derive membership from.
 *
 * They run beside `library-types-match-client` and `role-dependency` (graph-metadata.ts), in
 * `architecture:generate` and `validate-architecture-unchanged`, AFTER enrichGraph has resolved every
 * project's framework set and role — so a tag is read exactly one way. Every problem across every
 * project is collected and thrown as one MetadataValidationError, before anything is written.
 *
 * There is NO default (`.claude/rules/no-rule-defaults.md`): each rule's fields come from
 * webpieces.config.json, which must state them or fail to load. `TagTruthRules.none()` is what a unit
 * test or a caller that configured nothing asked for — not a default.
 */

import * as fs from 'fs';
import * as path from 'path';
import { loadAndValidate, matchesAnyGlob, RuleOptions } from "@webpieces/rules-config";
import { ApiClientPackagesEntry, FrameworkFolderEntry } from "../configs/tag-truth-configs";
import type { EnhancedGraph, GraphEntry } from './graph-sorter';
import { APP_ROLES, MetadataValidationError } from './graph-metadata';
import { ProjectInfo } from './project-info';
import { ProductResolver } from './product-resolver';
import { RuleGate } from './rule-gate';
import { DepUsageScanner } from './dep-usage-scanner';
import { toError } from '../toError';

/** The only field of a package.json this check reads. */
type RawPackageJson = { name?: string };

export const API_LIB_ROLE = 'api-lib';
export const API_CLIENT_ROLE = 'api-client';
const API_ROLES: readonly string[] = [API_LIB_ROLE, API_CLIENT_ROLE];

/** `api-lib-dependencies`, resolved: what an api library may import from outside the api-lib set. */
export class ApiLibDependenciesRule {
    constructor(
        /** Package / project names (globs allowed) every api-lib and api-client may depend on. */
        public readonly apiLibPackages: readonly string[],
        /** `role:api-client` project → the extra packages it may depend on. */
        public readonly apiClientPackages: ReadonlyMap<string, readonly string[]>,
    ) {}
}

/** `api-lib-path`, resolved: the globs every api project — and only api projects — lives under. */
export class ApiLibPathRule {
    constructor(public readonly paths: readonly string[]) {}
}

/** One `framework-folder` entry with its framework sets canonicalised (`a+b`, tokens sorted). */
export class FrameworkFolder {
    constructor(
        public readonly paths: readonly string[],
        public readonly frameworkSets: readonly string[],
        public readonly roles: readonly string[],
    ) {}

    /** A framework set written in any order, canonicalised: `node+browser` → `browser+node`. */
    // webpieces-disable no-function-outside-class -- static helper of this class
    static canonical(frameworks: readonly string[]): string {
        return [...new Set(frameworks.map((each: string) => each.trim()).filter((each: string) => each !== ''))]
            .sort()
            .join('+');
    }

    // webpieces-disable no-function-outside-class -- static factory of this class
    static fromEntry(entry: FrameworkFolderEntry): FrameworkFolder {
        return new FrameworkFolder(
            entry.paths,
            entry.frameworkSets.map((set: string) => FrameworkFolder.canonical(set.split('+'))),
            entry.roles,
        );
    }
}

/** `framework-folder`, resolved. Entry ORDER matters: the first entry whose glob matches governs. */
export class FrameworkFolderRule {
    constructor(public readonly folders: readonly FrameworkFolder[]) {}
}

/** `product-tags`, resolved: the roles whose every project must declare a `product:<name>` tag. */
export class ProductTagsRule {
    constructor(public readonly roles: readonly string[]) {}
}

/**
 * The four rules' switches, read from webpieces.config.json once. A rule that is OFF (or time-boxed /
 * branch-scoped off) is `null`.
 */
export class TagTruthRules {
    constructor(
        public readonly apiLibDependencies: ApiLibDependenciesRule | null,
        public readonly apiLibPath: ApiLibPathRule | null,
        public readonly frameworkFolder: FrameworkFolderRule | null,
        public readonly productTags: ProductTagsRule | null,
    ) {}

    /** Every rule off — what a caller that configured nothing asked for. */
    // webpieces-disable no-function-outside-class -- static factory of this class
    static none(): TagTruthRules {
        return new TagTruthRules(null, null, null, null);
    }

    anyEnabled(): boolean {
        return (
            this.apiLibDependencies !== null ||
            this.apiLibPath !== null ||
            this.frameworkFolder !== null ||
            this.productTags !== null
        );
    }

    /** `mode: OFF` and both escape hatches come from RuleGate, so there is ONE reading of them. */
    // webpieces-disable no-function-outside-class -- static factory of this class
    static fromConfig(workspaceRoot: string): TagTruthRules {
        const gate = new RuleGate();
        const rules = loadAndValidate(workspaceRoot).resolved.rules;
        // webpieces-disable no-any-unknown -- a validated rule entry is still opaque JSON in the option bag
        const optionsOf = (name: string): RuleOptions | null =>
            gate.isDisabled(workspaceRoot, name, true) ? null : (rules.get(name)?.options ?? null);

        const deps = optionsOf("api-lib-dependencies");
        const where = optionsOf("api-lib-path");
        const folder = optionsOf("framework-folder");
        const products = optionsOf("product-tags");
        return new TagTruthRules(
            deps === null ? null : TagTruthRules.dependenciesRule(deps),
            where === null ? null : new ApiLibPathRule(where['paths'] as string[]),
            folder === null
                ? null
                : new FrameworkFolderRule((folder['entries'] as FrameworkFolderEntry[]).map(FrameworkFolder.fromEntry)),
            products === null ? null : new ProductTagsRule(products['roles'] as string[]),
        );
    }

    // webpieces-disable no-function-outside-class -- private static reader of this class
    private static dependenciesRule(options: RuleOptions): ApiLibDependenciesRule {
        const clients = new Map<string, readonly string[]>();
        for (const entry of options['apiClients'] as ApiClientPackagesEntry[]) clients.set(entry.project, entry.packages);
        return new ApiLibDependenciesRule(options['apiLibPackages'] as string[], clients);
    }
}

/** What ONE project imports from production source, and the package name others import it by. */
export class ProjectImports {
    constructor(
        /** The project's own `package.json` name, or null when it has none. */
        public readonly packageName: string | null,
        /** Bare package names its production (non-test) source imports. */
        public readonly prodPackages: ReadonlySet<string>,
    ) {}
}

/** The pure check: every tag-truth problem in a graph whose framework sets and roles are resolved. */
export class TagTruthValidator {
    constructor(private readonly rules: TagTruthRules) {}

    problems(
        graph: EnhancedGraph,
        infos: Map<string, ProjectInfo>,
        imports: ReadonlyMap<string, ProjectImports>,
    ): string[] {
        const problems: string[] = [];
        for (const name of Object.keys(graph).sort()) {
            const entry = graph[name];
            const info = infos.get(name);
            if (info === undefined || info.root === '' || info.root === '.') continue;
            const root = info.root.replace(/\\/g, '/').replace(/\/+$/, '');
            if (this.rules.apiLibDependencies !== null) {
                problems.push(...this.dependencyProblems(name, entry, graph, imports, this.rules.apiLibDependencies));
            }
            if (this.rules.apiLibPath !== null) {
                problems.push(...this.pathProblems(name, root, entry, this.rules.apiLibPath));
            }
            if (this.rules.frameworkFolder !== null) {
                problems.push(...this.folderProblems(name, root, entry, this.rules.frameworkFolder));
            }
            if (this.rules.productTags !== null) {
                problems.push(...this.productTagProblems(info, root, entry, this.rules.productTags));
            }
        }
        return problems;
    }

    /**
     * #1179 — a project whose role the rule lists declares at least one well-formed `product:<name>`.
     * The DECLARED tags are read, never the derived `products`: a server inheriting membership from an
     * orchestrator that depends on it still states its own product. A malformed tag is not counted here
     * because enrichGraph already fails on it, naming the tag.
     */
    private productTagProblems(info: ProjectInfo, root: string, entry: GraphEntry, rule: ProductTagsRule): string[] {
        const role = entry.role;
        if (role === undefined || !rule.roles.includes(role)) return [];
        if (new ProductResolver().resolve(info).products.length > 0) return [];
        return [
            `${"product-tags"}: '${info.name}' is role:${role} but carries no product tag — every ` +
                `${rule.roles.map((each: string) => `role:${each}`).join(' / ')} must name the product(s) it belongs ` +
                `to, so the architecture graphs can show one product. Add "product:<name>" (lowercase kebab, ` +
                `several allowed) to the "tags" in ${root}/project.json, e.g. "tags": [..., "product:<name>"].`,
        ];
    }

    /** D2 — the workspace edges and the outside packages of ONE api-lib / api-client. */
    private dependencyProblems(
        name: string,
        entry: GraphEntry,
        graph: EnhancedGraph,
        imports: ReadonlyMap<string, ProjectImports>,
        rule: ApiLibDependenciesRule,
    ): string[] {
        const role = entry.role;
        if (role === undefined || !API_ROLES.includes(role)) return [];
        const rulePrefix = `${"api-lib-dependencies"}: '${name}' (role:${role})`;
        const clientPackages = rule.apiClientPackages.get(name);
        if (role === API_CLIENT_ROLE && clientPackages === undefined) {
            return [
                `${rulePrefix} has no apiClients entry — what an api-client talks to is stated, never inferred. ` +
                    `Add { "project": "${name}", "packages": [<its SDK, inversify, …>] } to ` +
                    `${"api-lib-dependencies"}.apiClients in webpieces.config.json, or retag it role:api-lib ` +
                    'if it bundles no implementation.',
            ];
        }
        const allowed = [...rule.apiLibPackages, ...(clientPackages ?? [])];
        const listName =
            role === API_CLIENT_ROLE ? `apiLibPackages or its apiClients entry` : 'apiLibPackages';
        const problems: string[] = [];
        const workspaceNames = new Set<string>();
        for (const dep of entry.dependsOn) {
            const depImports = imports.get(dep);
            if (depImports?.packageName) workspaceNames.add(depImports.packageName);
            const depRole = graph[dep]?.role;
            if (depRole === API_LIB_ROLE) continue;
            if (matchesAnyGlob(dep, allowed)) continue;
            if (depImports?.packageName && matchesAnyGlob(depImports.packageName, allowed)) continue;
            problems.push(
                `${rulePrefix} must not depend on '${dep}' (role:${depRole ?? 'none'}) — an api library depends ` +
                    `only on role:api-lib projects and the packages ${listName} lists. Move what it needs into a ` +
                    `role:api-lib project, or add '${depImports?.packageName ?? dep}' to ${listName}.`,
            );
        }
        const own = imports.get(name);
        for (const pkg of [...(own?.prodPackages ?? [])].sort()) {
            if (pkg === own?.packageName || workspaceNames.has(pkg) || this.isWorkspacePackage(pkg, imports)) continue;
            if (matchesAnyGlob(pkg, allowed)) continue;
            problems.push(
                `${rulePrefix} imports '${pkg}', which ${listName} does not list — an api library's wire contract ` +
                    `must not drag an outside runtime into every consumer. Remove the import, or add '${pkg}' ` +
                    `to ${"api-lib-dependencies"}.${role === API_CLIENT_ROLE ? `apiClients["${name}"].packages` : 'apiLibPackages'}.`,
            );
        }
        return problems;
    }

    /** A package some workspace project publishes — its edge is judged as a workspace dependency above. */
    private isWorkspacePackage(pkg: string, imports: ReadonlyMap<string, ProjectImports>): boolean {
        for (const each of imports.values()) if (each.packageName === pkg) return true;
        return false;
    }

    /** D10 — an api project lives under the api globs, and everything there is an api project. */
    private pathProblems(name: string, root: string, entry: GraphEntry, rule: ApiLibPathRule): string[] {
        const isApi = entry.role !== undefined && API_ROLES.includes(entry.role);
        const inPath = matchesAnyGlob(root, rule.paths);
        const globs = `[${rule.paths.join(', ')}]`;
        if (isApi && !inPath) {
            return [
                `${"api-lib-path"}: '${name}' is role:${entry.role} but lives at '${root}', outside ` +
                    `${"api-lib-path"}.paths ${globs} — move it under one of them ` +
                    '(nx g @nx/workspace:move), so every contract in the repo is found in one place.',
            ];
        }
        if (inPath && !isApi) {
            return [
                `${"api-lib-path"}: '${name}' lives at '${root}', under ${"api-lib-path"}.paths ` +
                    `${globs}, but is role:${entry.role ?? 'none'} — everything there is a contract. Retag it ` +
                    'role:api-lib (a contract and/or its DTOs) or role:api-client (a contract plus its SDK ' +
                    'adapter), or move it out of the api tree.',
            ];
        }
        return [];
    }

    /** D9 — the folder and the tags agree, both directions. */
    private folderProblems(name: string, root: string, entry: GraphEntry, rule: FrameworkFolderRule): string[] {
        if (entry.framework === undefined || entry.role === undefined) return [];
        const set = FrameworkFolder.canonical(entry.framework);
        const role = entry.role;
        const governing = rule.folders.find((folder: FrameworkFolder) => matchesAnyGlob(root, folder.paths));
        const prefix = `${"framework-folder"}: '${name}' at '${root}'`;
        if (governing !== undefined) {
            const problems: string[] = [];
            const glob = governing.paths.join(', ');
            if (!governing.frameworkSets.includes(set)) {
                problems.push(
                    `${prefix} carries framework set [${set}], but the folder ${glob} holds ` +
                        `[${governing.frameworkSets.join(' | ')}] — retag it to the folder's set, or move it to ` +
                        'the folder that holds its set.',
                );
            }
            if (!governing.roles.includes(role)) {
                problems.push(
                    `${prefix} is role:${role}, but the folder ${glob} holds role ` +
                        `${governing.roles.map((each: string) => `role:${each}`).join(' | ')} — retag it, or move it.`,
                );
            }
            return problems;
        }
        if (APP_ROLES.includes(role) || role === 'bundle') return [];
        const homes = rule.folders.filter(
            (folder: FrameworkFolder) => folder.frameworkSets.includes(set) && folder.roles.includes(role),
        );
        if (homes.length === 0) return [];
        const globs = homes.map((folder: FrameworkFolder) => folder.paths.join(', ')).join(' | ');
        return [
            `${prefix} is a role:${role} carrying [${set}], which ${"framework-folder"} places under ` +
                `${globs} — move it there (nx g @nx/workspace:move), so the folder tells a reader what runs where.`,
        ];
    }
}

/** The executor-facing entry point: read the config and the imports, check, and throw before any write. */
export class TagTruthCheck {
    assertTrue(graph: EnhancedGraph, infos: Map<string, ProjectInfo>, workspaceRoot: string): void {
        const rules = TagTruthRules.fromConfig(workspaceRoot);
        if (!rules.anyEnabled()) return;
        const imports = rules.apiLibDependencies === null ? new Map<string, ProjectImports>() : this.importsOf(infos, workspaceRoot);
        const problems = new TagTruthValidator(rules).problems(graph, infos, imports);
        if (problems.length > 0) throw new MetadataValidationError(problems);
    }

    /** Every project's production imports and package name, read from its source and package.json. */
    importsOf(infos: Map<string, ProjectInfo>, workspaceRoot: string): Map<string, ProjectImports> {
        const scanner = new DepUsageScanner();
        const found = new Map<string, ProjectImports>();
        for (const info of infos.values()) {
            if (info.root === '' || info.root === '.') continue;
            const abs = path.resolve(workspaceRoot, info.root);
            found.set(info.name, new ProjectImports(this.packageNameOf(abs), scanner.scan(abs).prodPackages));
        }
        return found;
    }

    private packageNameOf(projectDir: string): string | null {
        const file = path.join(projectDir, 'package.json');
        if (!fs.existsSync(file)) return null;
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as RawPackageJson;
            return typeof parsed.name === 'string' ? parsed.name : null;
        } catch (err: unknown) {
            const error = toError(err);
            throw new Error(`Failed to parse ${file} while reading the package name tag-truth checks against`, {
                cause: error,
            });
        }
    }
}
