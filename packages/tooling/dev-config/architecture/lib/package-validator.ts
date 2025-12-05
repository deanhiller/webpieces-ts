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

        // Collect all @webpieces/* dependencies
        for (const depType of ['dependencies', 'peerDependencies']) {
            const depObj = packageJson[depType] || {};
            for (const depName of Object.keys(depObj)) {
                if (depName.startsWith('@webpieces/') && !deps.includes(depName)) {
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
 * Validate that package.json dependencies match the dependency graph
 *
 * For each project in the graph:
 * - Check that all graph dependencies exist in package.json
 * - Optionally warn about extra deps in package.json not in graph
 *
 * @param graph - Enhanced graph with project dependencies
 * @param workspaceRoot - Absolute path to workspace root
 * @returns Validation result with errors if any
 */
export async function validatePackageJsonDependencies(
    graph: Record<string, { level: number; dependsOn: string[] }>,
    workspaceRoot: string
): Promise<ValidationResult> {
    const projectGraph = await createProjectGraphAsync();
    const projectsConfig = readProjectsConfigurationFromProjectGraph(projectGraph);

    const errors: string[] = [];
    const projectResults: ProjectValidationResult[] = [];

    for (const [projectName, entry] of Object.entries(graph)) {
        // Extract base name (remove @webpieces/ prefix)
        const baseName = projectName.replace('@webpieces/', '');

        // Find the project config
        const projectConfig = projectsConfig.projects[baseName];
        if (!projectConfig) {
            // Project not found in Nx config, skip
            continue;
        }

        const projectRoot = projectConfig.root;
        const packageJsonDeps = readPackageJsonDeps(workspaceRoot, projectRoot);

        // Skip projects without package.json (common for apps in monorepo)
        if (packageJsonDeps === null) {
            continue;
        }

        // Check for missing dependencies in package.json
        const missingInPackageJson: string[] = [];
        for (const dep of entry.dependsOn) {
            if (!packageJsonDeps.includes(dep)) {
                missingInPackageJson.push(dep);
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
