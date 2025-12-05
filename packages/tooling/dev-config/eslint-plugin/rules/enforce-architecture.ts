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
            try {
                const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf-8'));
                if (pkg.workspaces || pkg.name === 'webpieces-ts') {
                    return currentDir;
                }
            } catch (err: any) {
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

    try {
        const content = fs.readFileSync(graphPath, 'utf-8');
        cachedGraph = JSON.parse(content) as EnhancedGraph;
        cachedGraphPath = graphPath;
        return cachedGraph;
    } catch (err: any) {
        //const error = toError(err);
        // err is used below
        console.error(`[ESLint @webpieces/enforce-architecture] Could not load graph: ${err}`);
        return null;
    }
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
    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });

        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);

            if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
                // Check for project.json in this directory
                const projectJsonPath = path.join(fullPath, 'project.json');
                if (fs.existsSync(projectJsonPath)) {
                    try {
                        const projectJson = JSON.parse(fs.readFileSync(projectJsonPath, 'utf-8'));
                        const projectRoot = path.relative(workspaceRoot, fullPath);

                        // Determine project name
                        let projectName = projectJson.name || entry.name;

                        // Add @webpieces/ prefix if not present
                        if (!projectName.startsWith('@webpieces/')) {
                            projectName = `@webpieces/${projectName}`;
                        }

                        mappings.push({
                            root: projectRoot,
                            name: projectName,
                        });
                    } catch (err: any) {
                        //const error = toError(err);
                        void err;
                    }
                }

                // Continue scanning subdirectories
                scanForProjects(fullPath, workspaceRoot, mappings);
            }
        }
    } catch (err: any) {
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
                "Import '{{imported}}' violates architecture boundaries.\n\n" +
                "Project '{{project}}' (level {{level}}) can only import from:\n" +
                '{{allowedList}}\n\n' +
                'To allow this import:\n' +
                '1. Add dependency to project.json build.dependsOn\n' +
                '2. Add dependency to package.json dependencies\n' +
                '3. Run: nx run architecture:validate --mode=update\n' +
                '4. If cycle detected, refactor to break the cycle',
            noGraph:
                'No architecture graph found at architecture/dependencies.json\n' +
                'Run: nx run architecture:validate --mode=update',
        },
        schema: [],
    },

    create(context: Rule.RuleContext): Rule.RuleListener {
        const filename = context.filename || context.getFilename();
        const workspaceRoot = findWorkspaceRoot(filename);

        return {
            ImportDeclaration(node: any): void {
                const importPath = node.source.value as string;

                // Only check @webpieces/* imports
                if (!importPath.startsWith('@webpieces/')) {
                    return;
                }

                // Determine which project this file belongs to
                const project = getProjectFromFile(filename, workspaceRoot);
                if (!project) {
                    // File not in any known project (e.g., tools/, scripts/)
                    return;
                }

                // Self-import is always allowed
                if (importPath === project) {
                    return;
                }

                // Load blessed graph
                const graph = loadBlessedGraph(workspaceRoot);
                if (!graph) {
                    // No graph file - warn but don't fail (allows gradual adoption)
                    // Uncomment below to enforce graph existence:
                    // context.report({ node: node.source, messageId: 'noGraph' });
                    return;
                }

                // Get project entry
                const projectEntry = graph[project];
                if (!projectEntry) {
                    // Project not in graph (new project?) - allow
                    return;
                }

                // Compute allowed dependencies (direct + transitive)
                const allowedDeps = computeTransitiveDependencies(project, graph);

                // Check if import is allowed
                if (!allowedDeps.has(importPath)) {
                    const directDeps = projectEntry.dependsOn || [];
                    const allowedList =
                        directDeps.length > 0
                            ? directDeps.map((dep) => `  - ${dep}`).join('\n') +
                              '\n  (and their transitive dependencies)'
                            : '  (none - this is a foundation project)';

                    context.report({
                        node: node.source,
                        messageId: 'illegalImport',
                        data: {
                            imported: importPath,
                            project: project,
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
