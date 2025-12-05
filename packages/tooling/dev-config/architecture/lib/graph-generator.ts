/**
 * Graph Generator
 *
 * Generates dependency graph from project.json files in the workspace.
 * Reads build.dependsOn and implicitDependencies to determine project relationships.
 */

import {
    createProjectGraphAsync,
    readProjectsConfigurationFromProjectGraph,
    ProjectConfiguration,
} from '@nx/devkit';

/**
 * Projects to exclude from graph validation (tools, configs, etc.)
 */
const EXCLUDED_PROJECTS = new Set(['dev-config', 'rules']);

/**
 * Extract project dependencies from project.json's build.dependsOn and implicitDependencies
 */
function extractBuildDependencies(projectConfig: ProjectConfiguration): string[] {
    const deps: string[] = [];

    // 1. Read from build.dependsOn
    const buildTarget = projectConfig.targets?.['build'];
    if (buildTarget && buildTarget.dependsOn) {
        for (const dep of buildTarget.dependsOn) {
            if (typeof dep === 'string') {
                // Format: "project-name:build" or just "build" (for self)
                const match = dep.match(/^([^:]+):build$/);
                if (match) {
                    deps.push(match[1]);
                }
            }
        }
    }

    // 2. Also read from implicitDependencies
    if (projectConfig.implicitDependencies && Array.isArray(projectConfig.implicitDependencies)) {
        for (const dep of projectConfig.implicitDependencies) {
            if (typeof dep === 'string' && !deps.includes(dep)) {
                deps.push(dep);
            }
        }
    }

    return deps.sort();
}

/**
 * Generate raw dependency graph from project.json files
 * Returns: { projectName: [dependencyNames] }
 */
export async function generateRawGraph(): Promise<Record<string, string[]>> {
    const projectGraph = await createProjectGraphAsync();
    const projectsConfig = readProjectsConfigurationFromProjectGraph(projectGraph);
    const rawDeps: Record<string, string[]> = {};

    for (const [projectName, projectConfig] of Object.entries(projectsConfig.projects)) {
        // Skip excluded projects (tools, plugins)
        if (EXCLUDED_PROJECTS.has(projectName)) {
            continue;
        }

        // Extract dependencies from build.dependsOn in project.json
        const deps = extractBuildDependencies(projectConfig);
        rawDeps[projectName] = deps;
    }

    return rawDeps;
}

/**
 * Transform project names to @webpieces/xxx format
 */
export function transformGraph(rawGraph: Record<string, string[]>): Record<string, string[]> {
    const result: Record<string, string[]> = {};

    for (const [projectName, deps] of Object.entries(rawGraph)) {
        // Avoid double prefix if already has @webpieces/
        const transformedName = projectName.startsWith('@webpieces/')
            ? projectName
            : `@webpieces/${projectName}`;

        const transformedDeps = deps
            .map((d) => (d.startsWith('@webpieces/') ? d : `@webpieces/${d}`))
            .sort();

        result[transformedName] = transformedDeps;
    }

    return result;
}

/**
 * Generate complete dependency graph with transformations
 */
export async function generateGraph(): Promise<Record<string, string[]>> {
    const rawGraph = await generateRawGraph();
    return transformGraph(rawGraph);
}
