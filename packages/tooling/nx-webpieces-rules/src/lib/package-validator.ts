/**
 * Package Validator
 *
 * Validates that package.json dependencies match the architecture graph nx derived
 * from the source, and — critically — that each dependency is declared in the RIGHT
 * SECTION of package.json:
 *
 *   - reached from production source   → `dependencies` (or `peerDependencies`)
 *   - reached ONLY from test/dev files → `devDependencies`
 *
 * WHY the section matters: production images are built with
 * `pnpm --filter=<svc> deploy --prod`, which installs exactly the `dependencies`
 * closure. A test-support package parked in `dependencies` therefore ships test
 * machinery (auth-bypass hooks, canned credentials, fake datastores) into the
 * production container. Before this validator understood `devDependencies`, moving
 * such a package to its correct home FAILED the build — the tool enforced the
 * insecure layout. Now `devDependencies` is the required home for test-only deps,
 * and listing one in `dependencies` is itself a violation.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
    createProjectGraphAsync,
    readProjectsConfigurationFromProjectGraph,
} from '@nx/devkit';
import { DepUsage, DepUsageScanner } from './dep-usage-scanner';
import { toError } from '../toError';

/**
 * How hard to push back when a test-only package sits in `dependencies`
 * (i.e. inside the production deploy closure).
 *
 *  - 'error' (default): fails the build. This is the guardrail the security bug asked for.
 *  - 'warn': reports it without failing — the migration setting for a repo that needs a
 *    few releases to clean up its package.json files.
 *  - 'off': skip the check entirely.
 *
 * Missing deps, and production imports declared only in `devDependencies`, ALWAYS error:
 * their fix is unambiguous and the alternative is a broken runtime.
 */
export type TestOnlyDepMode = 'error' | 'warn' | 'off';

/**
 * Options for {@link validatePackageJsonDependencies}. Data-only (CLAUDE.md: data
 * structures are classes, never anonymous object literals).
 */
export class PackageValidatorOptions {
    testOnlyDepMode: TestOnlyDepMode;

    constructor(testOnlyDepMode: TestOnlyDepMode = 'error') {
        this.testOnlyDepMode = testOnlyDepMode;
    }
}

/**
 * Validation result for a single project
 */
export class ProjectValidationResult {
    project: string;
    valid: boolean;
    missingInPackageJson: string[];
    extraInPackageJson: string[];
    /** Graph deps that are test-only but declared in `dependencies` (production closure). */
    testOnlyInProdDependencies: string[];

    constructor(
        project: string,
        valid: boolean,
        missingInPackageJson: string[],
        extraInPackageJson: string[],
        testOnlyInProdDependencies: string[]
    ) {
        this.project = project;
        this.valid = valid;
        this.missingInPackageJson = missingInPackageJson;
        this.extraInPackageJson = extraInPackageJson;
        this.testOnlyInProdDependencies = testOnlyInProdDependencies;
    }
}

/**
 * Overall validation result
 *
 * `errors` fail the build. Every error's fix is either ADDITIVE ("add it to package.json")
 * or a MOVE between sections ("it belongs in devDependencies") — never "delete a
 * dependency", so no error can push a user toward removing a runtime-required package.
 *
 * `warnings` never fail the build. Workspace deps in package.json that the architecture
 * graph can't reach are reported here, NOT as errors: a transitively-reachable or even
 * unreachable entry can still be a real runtime dependency (e.g. a peerDependency or a
 * generated client that nx's import analysis doesn't traverse). Erroring on these is the
 * "runtime-validity trap" that previously forced a bad package.json edit — so we only warn.
 */
export class ValidationResult {
    valid: boolean;
    errors: string[];
    warnings: string[];
    projectResults: ProjectValidationResult[];

    constructor(
        valid: boolean,
        errors: string[],
        warnings: string[],
        projectResults: ProjectValidationResult[]
    ) {
        this.valid = valid;
        this.errors = errors;
        this.warnings = warnings;
        this.projectResults = projectResults;
    }
}

/**
 * The three package.json sections that matter, kept apart so the validator can say
 * WHICH one a package belongs in (the old code merged them and lost that information —
 * and never even read devDependencies).
 */
export class DeclaredDeps {
    dependencies: string[];
    devDependencies: string[];
    peerDependencies: string[];

    constructor(dependencies: string[], devDependencies: string[], peerDependencies: string[]) {
        this.dependencies = dependencies;
        this.devDependencies = devDependencies;
        this.peerDependencies = peerDependencies;
    }

    /** Every declared package name, deduped and sorted (all three sections). */
    all(): string[] {
        const merged = new Set<string>();
        for (const name of this.dependencies) merged.add(name);
        for (const name of this.devDependencies) merged.add(name);
        for (const name of this.peerDependencies) merged.add(name);
        return Array.from(merged).sort();
    }

    /** Declared somewhere that survives `pnpm deploy --prod`. */
    isProductionDeclared(packageName: string): boolean {
        return (
            this.dependencies.includes(packageName) ||
            this.peerDependencies.includes(packageName)
        );
    }

    isDevDeclared(packageName: string): boolean {
        return this.devDependencies.includes(packageName);
    }

    isDeclared(packageName: string): boolean {
        return this.isProductionDeclared(packageName) || this.isDevDeclared(packageName);
    }
}

/**
 * Graph shape produced by graph-sorter (an input contract we never construct here).
 */
interface GraphEntry {
    level: number;
    dependsOn: string[];
}

/**
 * Per-project classification of graph deps against what package.json declares.
 */
class DepClassification {
    /** Production-reached deps absent from `dependencies`/`peerDependencies`. */
    missingInPackageJson: string[] = [];
    /** Production-reached deps declared ONLY in `devDependencies` (runtime would break). */
    prodDepsOnlyInDev: string[] = [];
    /** Test-only deps declared in no section at all. */
    missingTestOnlyDeps: string[] = [];
    /** Test-only deps sitting in `dependencies` — i.e. shipped to production. */
    testOnlyInProdDependencies: string[] = [];
    /** Non-workspace (third-party) package.json entries — informational only. */
    extraInPackageJson: string[] = [];
    /** Workspace entries the graph cannot reach at all — warn-only drift. */
    extraWorkspaceDeps: string[] = [];
}

class SingleProjectValidation {
    result: ProjectValidationResult;
    errors: string[];
    warnings: string[];

    constructor(result: ProjectValidationResult, errors: string[], warnings: string[]) {
        this.result = result;
        this.errors = errors;
        this.warnings = warnings;
    }
}

/**
 * The per-workspace lookups a single-project validation needs, passed as one object
 * so method signatures stay readable.
 */
class ValidationContext {
    graph: Record<string, GraphEntry>;
    projectToPackage: Map<string, string>;
    packageToProject: Map<string, string>;
    options: PackageValidatorOptions;

    constructor(
        graph: Record<string, GraphEntry>,
        projectToPackage: Map<string, string>,
        packageToProject: Map<string, string>,
        options: PackageValidatorOptions
    ) {
        this.graph = graph;
        this.projectToPackage = projectToPackage;
        this.packageToProject = packageToProject;
        this.options = options;
    }
}

export class PackageValidator {
    private readonly scanner = new DepUsageScanner();

    /**
     * Read the three dependency sections of a project's package.json.
     * Returns null when there is no package.json (apps often have none) so the caller
     * can skip the project entirely.
     */
    readDeclaredDeps(workspaceRoot: string, projectRoot: string): DeclaredDeps | null {
        const packageJsonPath = path.join(workspaceRoot, projectRoot, 'package.json');
        if (!fs.existsSync(packageJsonPath)) {
            return null;
        }

        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
            return new DeclaredDeps(
                this.namesOf(packageJson, 'dependencies'),
                this.namesOf(packageJson, 'devDependencies'),
                this.namesOf(packageJson, 'peerDependencies')
            );
        } catch (err: unknown) {
            const error = toError(err);
            console.warn(`Could not read package.json at ${packageJsonPath}: ${error.message}`);
            return new DeclaredDeps([], [], []);
        }
    }

    // webpieces-disable no-any-unknown -- parsed JSON is inherently untyped
    private namesOf(packageJson: any, section: string): string[] {
        const depObj = packageJson[section] || {};
        return Object.keys(depObj).sort();
    }

    /**
     * Build map of project names to their package names
     * e.g., "core-util" → "@webpieces/core-util"
     */
    buildProjectToPackageMap(
        workspaceRoot: string,
        // webpieces-disable no-any-unknown -- Nx devkit projectsConfig type is dynamic and not strongly typed
        projectsConfig: any
    ): Map<string, string> {
        const map = new Map<string, string>();

        // webpieces-disable no-any-unknown -- Nx devkit projects config entries are untyped
        for (const configEntry of Object.entries<any>(projectsConfig.projects)) {
            const projectName = configEntry[0];
            const packageJsonPath = path.join(workspaceRoot, configEntry[1].root, 'package.json');
            if (!fs.existsSync(packageJsonPath)) continue;
            const packageName = this.readPackageName(packageJsonPath);
            if (packageName !== null) map.set(projectName, packageName);
        }

        return map;
    }

    private readPackageName(packageJsonPath: string): string | null {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
            return packageJson.name || null;
        } catch (err: unknown) {
            const error = toError(err);
            console.warn(`Could not parse ${packageJsonPath}: ${error.message}`);
            return null;
        }
    }

    /**
     * Compute the transitive closure of a project's dependencies in the graph.
     * Example: server → [core-meta, http-server]; the closure includes http-server and
     * everything http-server reaches.
     *
     * Used to allow package.json entries for transitive deps (a legitimate pattern:
     * npm install brings the whole dependency tree, so a consumer may list any reachable
     * package directly).
     */
    computeTransitiveClosure(
        projectName: string,
        graph: Record<string, GraphEntry>
    ): Set<string> {
        const closure = new Set<string>();
        const stack = [projectName];
        while (stack.length > 0) {
            const current = stack.pop()!;
            const entry = graph[current];
            if (!entry) continue;
            for (const dep of entry.dependsOn) {
                if (!closure.has(dep)) {
                    closure.add(dep);
                    stack.push(dep);
                }
            }
        }
        return closure;
    }

    /**
     * Split a project's graph deps into "declared correctly", "missing", and "declared in
     * the wrong section", using the import scan to decide which section each dep belongs in.
     */
    classifyDeps(
        declared: DeclaredDeps,
        usage: DepUsage,
        entry: GraphEntry,
        transitiveClosure: Set<string>,
        context: ValidationContext
    ): DepClassification {
        const classification = new DepClassification();

        for (const depProjectName of entry.dependsOn) {
            const depPackageName = context.projectToPackage.get(depProjectName) || depProjectName;
            this.classifyOneDep(depProjectName, depPackageName, declared, usage, classification);
        }

        // Workspace extras are OK if reachable via transitive closure (matches the ESLint
        // enforce-architecture rule which also allows transitive imports). Only flag extras
        // that are NOT reachable at all — real graph drift.
        for (const dep of declared.all()) {
            const depProjectName = context.packageToProject.get(dep);
            if (depProjectName === undefined) {
                classification.extraInPackageJson.push(dep);
                continue;
            }
            if (entry.dependsOn.includes(depProjectName)) continue;
            if (transitiveClosure.has(depProjectName)) continue;
            classification.extraWorkspaceDeps.push(dep);
        }

        return classification;
    }

    /**
     * The heart of the fix: which SECTION does this dep belong in?
     *
     * A dep is test-only when the scan saw it imported by test/dev files and by NO
     * production file. Anything else — including a dep we never saw imported at all (it
     * may be loaded reflectively at runtime) — is treated as production, so this can
     * never push a runtime-required package out of `dependencies`.
     */
    private classifyOneDep(
        depProjectName: string,
        depPackageName: string,
        declared: DeclaredDeps,
        usage: DepUsage,
        classification: DepClassification
    ): void {
        if (usage.isTestOnly(depPackageName)) {
            if (!declared.isDeclared(depPackageName)) {
                classification.missingTestOnlyDeps.push(depProjectName);
                return;
            }
            if (declared.dependencies.includes(depPackageName)) {
                classification.testOnlyInProdDependencies.push(depProjectName);
            }
            return;
        }

        if (declared.isProductionDeclared(depPackageName)) return;
        if (declared.isDevDeclared(depPackageName)) {
            classification.prodDepsOnlyInDev.push(depProjectName);
            return;
        }
        classification.missingInPackageJson.push(depProjectName);
    }

    validateSingleProject(
        projectName: string,
        entry: GraphEntry,
        projectRoot: string,
        declared: DeclaredDeps,
        usage: DepUsage,
        context: ValidationContext
    ): SingleProjectValidation {
        const transitiveClosure = this.computeTransitiveClosure(projectName, context.graph);
        const classification = this.classifyDeps(
            declared,
            usage,
            entry,
            transitiveClosure,
            context
        );

        const where = `Project ${projectName} (${projectRoot}/package.json)`;
        const errors = this.buildErrors(where, classification, context.options);
        const warnings = this.buildWarnings(where, projectName, classification, context);

        const missing = classification.missingInPackageJson.concat(
            classification.missingTestOnlyDeps
        );
        const result = new ProjectValidationResult(
            projectName,
            errors.length === 0,
            missing,
            classification.extraInPackageJson,
            classification.testOnlyInProdDependencies
        );
        return new SingleProjectValidation(result, errors, warnings);
    }

    private buildErrors(
        where: string,
        classification: DepClassification,
        options: PackageValidatorOptions
    ): string[] {
        const errors: string[] = [];
        if (classification.missingInPackageJson.length > 0) {
            errors.push(
                `${where} is missing dependencies: ${classification.missingInPackageJson.join(', ')}\n` +
                    `  These are imported by PRODUCTION source files.\n` +
                    `  Fix: Add them to package.json "dependencies"`
            );
        }
        if (classification.missingTestOnlyDeps.length > 0) {
            errors.push(
                `${where} is missing dependencies: ${classification.missingTestOnlyDeps.join(', ')}\n` +
                    `  These are imported ONLY by test/dev files (*.spec.ts, __tests__/, test configs).\n` +
                    `  Fix: Add them to package.json "devDependencies" — NOT "dependencies", which would ship them to production`
            );
        }
        if (classification.prodDepsOnlyInDev.length > 0) {
            errors.push(
                `${where} declares production imports only in devDependencies: ${classification.prodDepsOnlyInDev.join(', ')}\n` +
                    `  Production source files import them, so \`pnpm deploy --prod\` would omit them and the runtime would break.\n` +
                    `  Fix: Move them to package.json "dependencies"`
            );
        }
        const testOnlyInProd = classification.testOnlyInProdDependencies;
        if (options.testOnlyDepMode === 'error' && testOnlyInProd.length > 0) {
            errors.push(this.testOnlyInProdMessage(where, testOnlyInProd));
        }
        return errors;
    }

    private buildWarnings(
        where: string,
        projectName: string,
        classification: DepClassification,
        context: ValidationContext
    ): string[] {
        const warnings: string[] = [];

        const testOnlyInProd = classification.testOnlyInProdDependencies;
        if (context.options.testOnlyDepMode === 'warn' && testOnlyInProd.length > 0) {
            warnings.push(this.testOnlyInProdMessage(where, testOnlyInProd));
        }

        // Unreachable workspace extras are WARN-ONLY: they may be real runtime deps that nx's
        // import analysis can't see (peerDependency / generated client). Never error — that is
        // the runtime-validity trap. We surface them so genuine drift is still visible.
        for (const extraPkg of classification.extraWorkspaceDeps) {
            const extraProject = context.packageToProject.get(extraPkg);
            warnings.push(
                `${where} has "${extraPkg}" but the architecture graph has no path ${projectName} → ${extraProject}.\n` +
                    `  This is allowed (it may be a runtime-only/peer dependency). If it is genuinely unused, you may remove it.`
            );
        }
        return warnings;
    }

    private testOnlyInProdMessage(where: string, deps: string[]): string {
        return (
            `${where} lists test-only packages in "dependencies": ${deps.join(', ')}\n` +
            `  No production source file imports them — only test/dev files do — yet \`pnpm deploy --prod\`\n` +
            `  installs the "dependencies" closure, so this ships test machinery (fakes, auth-bypass hooks,\n` +
            `  canned credentials) into the production image.\n` +
            `  Fix: Move them to package.json "devDependencies"`
        );
    }

    async validate(
        graph: Record<string, GraphEntry>,
        workspaceRoot: string,
        options: PackageValidatorOptions
    ): Promise<ValidationResult> {
        const projectGraph = await createProjectGraphAsync();
        const projectsConfig = readProjectsConfigurationFromProjectGraph(projectGraph);

        const projectToPackage = this.buildProjectToPackageMap(workspaceRoot, projectsConfig);
        const packageToProject = new Map<string, string>();
        for (const pair of projectToPackage.entries()) {
            packageToProject.set(pair[1], pair[0]);
        }
        const context = new ValidationContext(graph, projectToPackage, packageToProject, options);

        const errors: string[] = [];
        const warnings: string[] = [];
        const projectResults: ProjectValidationResult[] = [];

        for (const graphPair of Object.entries(graph)) {
            const projectName = graphPair[0];
            const entry = graphPair[1];
            const projectConfig = projectsConfig.projects[projectName];
            if (!projectConfig) continue;

            const declared = this.readDeclaredDeps(workspaceRoot, projectConfig.root);
            if (declared === null) continue;

            const usage = this.scanner.scan(path.join(workspaceRoot, projectConfig.root));
            const validation = this.validateSingleProject(
                projectName,
                entry,
                projectConfig.root,
                declared,
                usage,
                context
            );
            projectResults.push(validation.result);
            errors.push(...validation.errors);
            warnings.push(...validation.warnings);
        }

        return new ValidationResult(errors.length === 0, errors, warnings, projectResults);
    }
}

/**
 * Validate that package.json dependencies cover the dependency graph AND that each dep
 * is declared in the correct section (dependencies vs devDependencies).
 *
 * @param graph - Enhanced graph with project dependencies (uses project names)
 * @param workspaceRoot - Absolute path to workspace root
 * @param options - Strictness of the "test-only dep in the production closure" check
 */
// webpieces-disable no-function-outside-class -- stable module entry point imported by the executor; it only delegates to PackageValidator
export async function validatePackageJsonDependencies(
    graph: Record<string, GraphEntry>,
    workspaceRoot: string,
    options: PackageValidatorOptions = new PackageValidatorOptions()
): Promise<ValidationResult> {
    return new PackageValidator().validate(graph, workspaceRoot, options);
}
