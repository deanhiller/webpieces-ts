/**
 * ESLint rule to enforce architecture boundaries
 *
 * Validates that imports from @webpieces/* packages comply with the
 * blessed dependency graph in .graphs/dependencies.json
 *
 * Supports transitive dependencies: if A depends on B and B depends on C,
 * then A can import from C.
 *
 * Configuration:
 * '@webpieces/enforce-architecture': 'error'
 */

import type { Rule } from 'eslint';
import * as fs from 'fs';
import * as path from 'path';
import { writeTemplateIfMissing } from '@webpieces/rules-config';
import { toError } from '../toError';

// Module-level flag to prevent redundant file creation
let dependenciesDocCreated = false;

/**
 * Ensure the dependencies documentation file exists at
 * .webpieces/instruct-ai/webpieces.dependencies.md. Sourced from @webpieces/rules-config.
 */
function ensureDependenciesDoc(workspaceRoot: string): void {
    if (dependenciesDocCreated) return;
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        writeTemplateIfMissing(workspaceRoot, 'webpieces.dependencies.md');
        dependenciesDocCreated = true;
    } catch (err: unknown) {
        void err;
        console.warn('[webpieces] Could not write webpieces.dependencies.md');
    }
}

/**
 * Graph entry format from .graphs/dependencies.json
 */
interface GraphEntry {
    level: number;
    dependsOn: string[];
}

type EnhancedGraph = Record<string, GraphEntry>;

/**
 * Project mapping entry
 */
interface ProjectMapping {
    root: string;
    name: string;
}

// Cache for blessed graph (loaded once per lint run)
let cachedGraph: EnhancedGraph | null = null;
let cachedGraphPath: string | null = null;

// Cache for project mappings
let cachedProjectMappings: ProjectMapping[] | null = null;

/**
 * Find workspace root by walking up from file location
 */
function findWorkspaceRoot(startPath: string): string {
    let currentDir = path.dirname(startPath);

    for (let i = 0; i < 20; i++) {
        const packagePath = path.join(currentDir, 'package.json');
        if (fs.existsSync(packagePath)) {
            // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
            try {
                const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf-8'));
                if (pkg.workspaces || pkg.name === 'webpieces-ts') {
                    return currentDir;
                }
            } catch (err: unknown) {
                //const error = toError(err);
                void err;
            }
        }

        const parent = path.dirname(currentDir);
        if (parent === currentDir) break;
        currentDir = parent;
    }

    return process.cwd();
}

/**
 * Load blessed graph from architecture/dependencies.json
 */
function loadBlessedGraph(workspaceRoot: string): EnhancedGraph | null {
    const graphPath = path.join(workspaceRoot, 'architecture', 'dependencies.json');

    // Return cached if same path
    if (cachedGraphPath === graphPath && cachedGraph !== null) {
        return cachedGraph;
    }

    if (!fs.existsSync(graphPath)) {
        return null;
    }

    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        const content = fs.readFileSync(graphPath, 'utf-8');
        cachedGraph = JSON.parse(content) as EnhancedGraph;
        cachedGraphPath = graphPath;
        return cachedGraph;
    } catch (err: unknown) {
        const error = toError(err);
        console.error(`[ESLint @webpieces/enforce-architecture] Could not load graph: ${error.message}`);
        return null;
    }
}

/**
 * Build set of all workspace package names (from package.json files)
 * Used to detect workspace imports (works for any scope or unscoped)
 */
function buildWorkspacePackageNames(workspaceRoot: string): Set<string> {
    const packageNames = new Set<string>();
    const mappings = buildProjectMappings(workspaceRoot);

    for (const mapping of mappings) {
        const pkgJsonPath = path.join(workspaceRoot, mapping.root, 'package.json');
        if (fs.existsSync(pkgJsonPath)) {
            // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
            try {
                const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
                if (pkgJson.name) {
                    packageNames.add(pkgJson.name);
                }
            } catch (err: unknown) {
                //const error = toError(err);
                void err; // Ignore parse errors
            }
        }
    }

    return packageNames;
}

/**
 * Check if an import path is a workspace project
 * Works for scoped (@scope/name) or unscoped (name) packages
 */
function isWorkspaceImport(importPath: string, workspaceRoot: string): boolean {
    const workspacePackages = buildWorkspacePackageNames(workspaceRoot);
    return workspacePackages.has(importPath);
}

/**
 * Get project name from package name
 * e.g., '@webpieces/client' → 'client', 'apis' → 'apis'
 */
function getProjectNameFromPackageName(packageName: string, workspaceRoot: string): string {
    const mappings = buildProjectMappings(workspaceRoot);

    // Try to find by reading package.json files
    for (const mapping of mappings) {
        const pkgJsonPath = path.join(workspaceRoot, mapping.root, 'package.json');
        if (fs.existsSync(pkgJsonPath)) {
            // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
            try {
                const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
                if (pkgJson.name === packageName) {
                    return mapping.name; // Return project name
                }
            } catch (err: unknown) {
                //const error = toError(err);
                void err; // Ignore parse errors
            }
        }
    }

    // Fallback: return package name as-is (might be unscoped project name)
    return packageName;
}

/**
 * Build project mappings from project.json files in workspace
 */
function buildProjectMappings(workspaceRoot: string): ProjectMapping[] {
    if (cachedProjectMappings !== null) {
        return cachedProjectMappings;
    }

    const mappings: ProjectMapping[] = [];

    // Scan common locations for project.json files
    const searchDirs = ['packages', 'apps', 'libs', 'libraries', 'services'];

    for (const searchDir of searchDirs) {
        const searchPath = path.join(workspaceRoot, searchDir);
        if (!fs.existsSync(searchPath)) continue;

        scanForProjects(searchPath, workspaceRoot, mappings);
    }

    // Sort by path length (longest first) for more specific matching
    mappings.sort((a, b) => b.root.length - a.root.length);

    cachedProjectMappings = mappings;
    return mappings;
}

/**
 * Recursively scan for project.json files
 */
function scanForProjects(
    dir: string,
    workspaceRoot: string,
    mappings: ProjectMapping[]
): void {
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });

        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);

            if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
                // Check for project.json in this directory
                const projectJsonPath = path.join(fullPath, 'project.json');
                if (fs.existsSync(projectJsonPath)) {
                    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
                    try {
                        const projectJson = JSON.parse(fs.readFileSync(projectJsonPath, 'utf-8'));
                        const projectRoot = path.relative(workspaceRoot, fullPath);

                        // Use project name from project.json as-is (no scope forcing)
                        const projectName = projectJson.name || entry.name;

                        mappings.push({
                            root: projectRoot,
                            name: projectName,
                        });
                    } catch (err: unknown) {
                        //const error = toError(err);
                        void err;
                    }
                }

                // Continue scanning subdirectories
                scanForProjects(fullPath, workspaceRoot, mappings);
            }
        }
    } catch (err: unknown) {
        //const error = toError(err);
        void err;
    }
}

/**
 * Get project name from file path
 */
function getProjectFromFile(filePath: string, workspaceRoot: string): string | null {
    const relativePath = path.relative(workspaceRoot, filePath).replace(/\\/g, '/');
    const mappings = buildProjectMappings(workspaceRoot);

    for (const mapping of mappings) {
        if (relativePath.startsWith(mapping.root + '/') || relativePath.startsWith(mapping.root)) {
            return mapping.name;
        }
    }

    return null;
}

/**
 * Compute all transitive dependencies for a project
 */
function computeTransitiveDependencies(project: string, graph: EnhancedGraph): Set<string> {
    const result = new Set<string>();
    const visited = new Set<string>();

    function visit(currentProject: string): void {
        if (visited.has(currentProject)) return;
        visited.add(currentProject);

        const entry = graph[currentProject];
        if (!entry || !entry.dependsOn) return;

        for (const dep of entry.dependsOn) {
            result.add(dep);
            visit(dep);
        }
    }

    visit(project);
    return result;
}

function buildAllowedDepsList(allowedDeps: Set<string>, graph: EnhancedGraph): string {
    const sorted = Array.from(allowedDeps).sort((a, b) => {
        const diff = (graph[b]?.level ?? 0) - (graph[a]?.level ?? 0);
        return diff !== 0 ? diff : a.localeCompare(b);
    });
    if (sorted.length === 0) return '  (none - this is a foundation project)';
    return sorted.map((dep) => `  - ${dep} (level ${graph[dep]?.level ?? '?'})`).join('\n');
}

const rule: Rule.RuleModule = {
    meta: {
        type: 'problem',
        docs: {
            description: 'Enforce blessed architecture dependencies',
            category: 'Best Practices',
            recommended: true,
            url: 'https://github.com/deanhiller/webpieces-ts',
        },
        messages: {
            illegalImport:
                "⚠️ AI Agent: READ .webpieces/instruct-ai/webpieces.dependencies.md for resolution steps!\n\n" +
                "Import '{{imported}}' violates architecture boundaries.\n\n" +
                "Project '{{project}}' (level {{level}}) can only import from:\n" +
                '{{allowedList}}',
            noGraph:
                'No architecture graph found at architecture/dependencies.json\n' +
                'Run: nx run architecture:validate --mode=update',
        },
        schema: [],
    },

    // webpieces-disable max-lines-new-methods -- ESLint rule create method with AST validation
    create(context: Rule.RuleContext): Rule.RuleListener {
        const filename = context.filename || context.getFilename();
        const workspaceRoot = findWorkspaceRoot(filename);

        return {
            // webpieces-disable no-any-unknown -- ESLint visitor callback receives untyped AST node
            ImportDeclaration(node: any): void {
                const importPath = node.source.value as string;

                // Check if this is a workspace import (works for any scope or unscoped)
                if (!isWorkspaceImport(importPath, workspaceRoot)) {
                    return; // Not a workspace import, skip validation
                }

                // Determine which project this file belongs to
                const sourceProject = getProjectFromFile(filename, workspaceRoot);
                if (!sourceProject) {
                    // File not in any known project (e.g., tools/, scripts/)
                    return;
                }

                // Convert import (package name) to project name
                const targetProject = getProjectNameFromPackageName(importPath, workspaceRoot);

                // Self-import is always allowed
                if (targetProject === sourceProject) {
                    return;
                }

                // Load blessed graph
                const graph = loadBlessedGraph(workspaceRoot);
                if (!graph) {
                    // No graph file - warn but don't fail (allows gradual adoption)
                    return;
                }

                // Get project entry
                const projectEntry = graph[sourceProject];
                if (!projectEntry) {
                    // Project not in graph (new project?) - allow
                    return;
                }

                // Compute allowed dependencies (direct + transitive)
                const allowedDeps = computeTransitiveDependencies(sourceProject, graph);

                // Check if import is allowed (use project name, not package name)
                if (!allowedDeps.has(targetProject)) {
                    // Write documentation file for AI/developer to read
                    ensureDependenciesDoc(workspaceRoot);

                    const allowedList = buildAllowedDepsList(allowedDeps, graph);

                    context.report({
                        node: node.source,
                        messageId: 'illegalImport',
                        data: {
                            imported: importPath,
                            project: sourceProject,
                            level: String(projectEntry.level),
                            allowedList: allowedList,
                        },
                    });
                }
            },
        };
    },
};

export = rule;
