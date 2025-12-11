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
    projectsConfig: any
): Map<string, string> {
    const map = new Map<string, string>();

    for (const [projectName, config] of Object.entries<any>(projectsConfig.projects)) {
        const packageJsonPath = path.join(workspaceRoot, config.root, 'package.json');
        if (fs.existsSync(packageJsonPath)) {
            try {
                const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
                if (packageJson.name) {
                    map.set(projectName, packageJson.name);
                }
            } catch {
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
export async function validatePackageJsonDependencies(
    graph: Record<string, { level: number; dependsOn: string[] }>,
    workspaceRoot: string
): Promise<ValidationResult> {
    const projectGraph = await createProjectGraphAsync();
    const projectsConfig = readProjectsConfigurationFromProjectGraph(projectGraph);

    // Build map: project name → package name
    const projectToPackage = buildProjectToPackageMap(workspaceRoot, projectsConfig);

    const errors: string[] = [];
    const projectResults: ProjectValidationResult[] = [];

    for (const [projectName, entry] of Object.entries(graph)) {
        // Find the project config using project name directly
        const projectConfig = projectsConfig.projects[projectName];
        if (!projectConfig) {
            continue;
        }

        const projectRoot = projectConfig.root;
        const packageJsonDeps = readPackageJsonDeps(workspaceRoot, projectRoot);

        if (packageJsonDeps === null) {
            continue;
        }

        // Convert graph dependencies (project names) to package names for comparison
        const missingInPackageJson: string[] = [];
        for (const depProjectName of entry.dependsOn) {
            const depPackageName = projectToPackage.get(depProjectName) || depProjectName;
            if (!packageJsonDeps.includes(depPackageName)) {
                missingInPackageJson.push(depProjectName);
            }
        }

        // Check for extra dependencies in package.json (not critical, just informational)
        const extraInPackageJson: string[] = [];
        for (const dep of packageJsonDeps) {
            if (!entry.dependsOn.includes(dep)) {
                extraInPackageJson.push(dep);
            }
        }

        const valid = missingInPackageJson.length === 0;

        if (!valid) {
            errors.push(
                `Project ${projectName} (${projectRoot}/package.json) is missing dependencies: ${missingInPackageJson.join(', ')}\n` +
                    `  Fix: Add these to package.json dependencies`
            );
        }

        projectResults.push({
            project: projectName,
            valid,
            missingInPackageJson,
            extraInPackageJson,
        });
    }

    return {
        valid: errors.length === 0,
        errors,
        projectResults,
    };
}
