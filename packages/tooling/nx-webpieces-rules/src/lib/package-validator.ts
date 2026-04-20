/**
 * Package Validator
 *
 * Validates that package.json dependencies match the project.json build.dependsOn
 * This ensures the two sources of truth don't drift apart.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
    createProjectGraphAsync,
    readProjectsConfigurationFromProjectGraph,
} from '@nx/devkit';
import { toError } from '../toError';

/**
 * Validation result for a single project
 */
export interface ProjectValidationResult {
    project: string;
    valid: boolean;
    missingInPackageJson: string[];
    extraInPackageJson: string[];
}

/**
 * Overall validation result
 */
export interface ValidationResult {
    valid: boolean;
    errors: string[];
    projectResults: ProjectValidationResult[];
}

/**
 * Read package.json dependencies for a project
 * Returns null if package.json doesn't exist (apps often don't have one)
 */
function readPackageJsonDeps(workspaceRoot: string, projectRoot: string): string[] | null {
    const packageJsonPath = path.join(workspaceRoot, projectRoot, 'package.json');

    if (!fs.existsSync(packageJsonPath)) {
        return null; // No package.json - skip validation for this project
    }

    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
        const deps: string[] = [];

        // Collect ALL dependencies from package.json
        for (const depType of ['dependencies', 'peerDependencies']) {
            const depObj = packageJson[depType] || {};
            for (const depName of Object.keys(depObj)) {
                if (!deps.includes(depName)) {
                    deps.push(depName);
                }
            }
        }

        return deps.sort();
    } catch (err: unknown) {
        //const error = toError(err);
        void err;
        console.warn(`Could not read package.json at ${packageJsonPath}`);
        return [];
    }
}

/**
 * Build map of project names to their package names
 * e.g., "core-util" → "@webpieces/core-util"
 */
function buildProjectToPackageMap(
    workspaceRoot: string,
    // webpieces-disable no-any-unknown -- Nx devkit projectsConfig type is dynamic and not strongly typed
    projectsConfig: any
): Map<string, string> {
    const map = new Map<string, string>();

    // webpieces-disable no-any-unknown -- Nx devkit projects config entries are untyped
    for (const [projectName, config] of Object.entries<any>(projectsConfig.projects)) {
        const packageJsonPath = path.join(workspaceRoot, config.root, 'package.json');
        if (fs.existsSync(packageJsonPath)) {
            // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
            try {
                const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
                if (packageJson.name) {
                    map.set(projectName, packageJson.name);
                }
            } catch (err: unknown) {
                //const error = toError(err);
                void err;
                // Ignore parse errors
            }
        }
    }

    return map;
}

/**
 * Validate that package.json dependencies match the dependency graph
 *
 * For each project in the graph:
 * - Check that all graph dependencies exist in package.json
 * - Maps project names to package names for accurate comparison
 *
 * @param graph - Enhanced graph with project dependencies (uses project names)
 * @param workspaceRoot - Absolute path to workspace root
 * @returns Validation result with errors if any
 */
interface GraphEntry {
    level: number;
    dependsOn: string[];
}

interface DepClassification {
    missingInPackageJson: string[];
    extraInPackageJson: string[];
    extraWorkspaceDeps: string[];
}

/**
 * Compute the transitive closure of a project's dependencies in the graph.
 * Example: server → [core-meta, http-server]; transitive closure includes
 * http-server and everything http-server reaches (http-routing, http-filters,
 * core-context, core-util, http-api).
 *
 * Used to allow package.json entries for transitive deps (a legitimate pattern:
 * npm install brings the whole dependency tree, so a consumer may list any
 * reachable package directly).
 */
function computeTransitiveClosure(
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

interface SingleProjectValidation {
    result: ProjectValidationResult;
    errors: string[];
}

function classifyDeps(
    packageJsonDeps: string[],
    entry: GraphEntry,
    transitiveClosure: Set<string>,
    projectToPackage: Map<string, string>,
    packageToProject: Map<string, string>
): DepClassification {
    const missingInPackageJson: string[] = [];
    for (const depProjectName of entry.dependsOn) {
        const depPackageName = projectToPackage.get(depProjectName) || depProjectName;
        if (!packageJsonDeps.includes(depPackageName)) {
            missingInPackageJson.push(depProjectName);
        }
    }

    // Workspace extras are OK if reachable via transitive closure (matches the
    // ESLint enforce-architecture rule which also allows transitive imports).
    // Only flag extras that are NOT reachable at all — real graph drift.
    const extraInPackageJson: string[] = [];
    const extraWorkspaceDeps: string[] = [];
    for (const dep of packageJsonDeps) {
        const depProjectName = packageToProject.get(dep);
        if (depProjectName === undefined) {
            extraInPackageJson.push(dep);
            continue;
        }
        if (entry.dependsOn.includes(depProjectName)) continue;
        if (transitiveClosure.has(depProjectName)) continue;
        extraWorkspaceDeps.push(dep);
    }

    return { missingInPackageJson, extraInPackageJson, extraWorkspaceDeps };
}

function validateSingleProject(
    projectName: string,
    entry: GraphEntry,
    projectRoot: string,
    packageJsonDeps: string[],
    graph: Record<string, GraphEntry>,
    projectToPackage: Map<string, string>,
    packageToProject: Map<string, string>
): SingleProjectValidation {
    const transitiveClosure = computeTransitiveClosure(projectName, graph);
    const classification = classifyDeps(
        packageJsonDeps,
        entry,
        transitiveClosure,
        projectToPackage,
        packageToProject
    );

    const errors: string[] = [];
    if (classification.missingInPackageJson.length > 0) {
        errors.push(
            `Project ${projectName} (${projectRoot}/package.json) is missing dependencies: ${classification.missingInPackageJson.join(', ')}\n` +
                `  Fix: Add these to package.json dependencies`
        );
    }
    for (const extraPkg of classification.extraWorkspaceDeps) {
        const extraProject = packageToProject.get(extraPkg);
        errors.push(
            `Project ${projectName} (${projectRoot}/package.json) has "${extraPkg}" in package.json but architecture/dependencies.json has no path ${projectName} → ${extraProject} (not even transitively).\n` +
                `  Fix: Either add "${extraProject}:build" to project.json:build.dependsOn (then run \`nx run architecture:generate\`), or remove "${extraPkg}" from package.json dependencies.`
        );
    }

    const valid =
        classification.missingInPackageJson.length === 0 &&
        classification.extraWorkspaceDeps.length === 0;
    return {
        result: {
            project: projectName,
            valid,
            missingInPackageJson: classification.missingInPackageJson,
            extraInPackageJson: classification.extraInPackageJson,
        },
        errors,
    };
}

export async function validatePackageJsonDependencies(
    graph: Record<string, GraphEntry>,
    workspaceRoot: string
): Promise<ValidationResult> {
    const projectGraph = await createProjectGraphAsync();
    const projectsConfig = readProjectsConfigurationFromProjectGraph(projectGraph);

    const projectToPackage = buildProjectToPackageMap(workspaceRoot, projectsConfig);
    const packageToProject = new Map<string, string>();
    for (const [projName, pkgName] of projectToPackage.entries()) {
        packageToProject.set(pkgName, projName);
    }

    const errors: string[] = [];
    const projectResults: ProjectValidationResult[] = [];

    for (const [projectName, entry] of Object.entries(graph)) {
        const projectConfig = projectsConfig.projects[projectName];
        if (!projectConfig) continue;

        const packageJsonDeps = readPackageJsonDeps(workspaceRoot, projectConfig.root);
        if (packageJsonDeps === null) continue;

        const validation = validateSingleProject(
            projectName,
            entry,
            projectConfig.root,
            packageJsonDeps,
            graph,
            projectToPackage,
            packageToProject
        );
        projectResults.push(validation.result);
        errors.push(...validation.errors);
    }

    return { valid: errors.length === 0, errors, projectResults };
}
