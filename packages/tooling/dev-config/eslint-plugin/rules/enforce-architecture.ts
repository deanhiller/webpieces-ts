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

const DEPENDENCIES_DOC_CONTENT = `# Instructions: Architecture Dependency Violation

IN GENERAL, it is better to avoid these changes and find a different way by moving classes
around to existing packages you already depend on. It is not always avoidable though.
A clean dependency graph keeps you out of huge trouble later.

If you are a human, simply run these commands:
* nx run architecture:visualize - to see the new dependencies and validate that change is desired
* nx run architecture:generate - updates the dep graph
* git diff architecture/dependencies.json - to see the deps changes you made

**READ THIS FILE FIRST before making any changes!**

## ⚠️ CRITICAL WARNING ⚠️

**This is a VERY IMPORTANT change that has LARGE REPERCUSSIONS later!**

Adding new dependencies creates technical debt that compounds over time:
- Creates coupling between packages that may be hard to undo
- Can create circular dependency tangles
- Makes packages harder to test in isolation
- Increases build times and bundle sizes
- May force unnecessary upgrades across the codebase

**DO NOT add dependencies without senior developer approval!**

## Understanding the Error

You've attempted to import from a package that is not in your project's allowed dependencies.
The architecture enforces a layered dependency structure where:
- Level 0 packages are foundation packages with NO dependencies on other @webpieces packages
- Higher level packages can only depend on lower level packages
- All dependencies must be explicitly declared

## Steps to Resolve

### Step 1: Generate Current Dependency Graph
Run this command to see the current architecture:
\`\`\`bash
npx nx run architecture:generate
\`\`\`
This creates/updates \`architecture/dependencies.json\` showing all packages and their levels.

### Step 2: Analyze the Proposed Change
Ask yourself:
1. **Is this import truly necessary?** Can you refactor to avoid it?
2. **Should the code move instead?** Maybe the code belongs in a different package.
3. **Will this create a cycle?** Use \`npx nx graph\` to visualize dependencies.
4. **Can you use an interface/abstraction?** Define interface in lower-level package, implement in higher-level.

### Step 3: Get Senior Developer Approval

## 🛑 AI AGENTS: STOP HERE AND ASK FOR HUMAN APPROVAL! 🛑

**YOU MUST NOT PROCEED TO STEP 4 WITHOUT EXPLICIT HUMAN APPROVAL!**

**REQUIRED**: Discuss this architectural change with a senior developer before proceeding.
- Explain why the dependency is needed
- Show you've considered alternatives (Step 2)
- **WAIT for explicit approval before making ANY changes to project.json or package.json**

**AI Agent Instructions:**
1. Present your analysis from Step 2 to the human
2. Explain which package needs which dependency and why
3. ASK: "Do you approve adding this dependency?"
4. **DO NOT modify project.json or package.json until you receive explicit "yes" or approval**

### Step 4: If Approved, Add the Dependency

## ⛔ NEVER MODIFY THESE FILES WITHOUT HUMAN APPROVAL FROM STEP 3! ⛔

Only after receiving explicit human approval in Step 3, make these changes:

1. **Update project.json** - Add to \`build.dependsOn\`:
   \`\`\`json
   {
     "targets": {
       "build": {
         "dependsOn": ["^build", "dep1:build", "NEW_PACKAGE:build"]
       }
     }
   }
   \`\`\`

2. **Update package.json** - Add to \`dependencies\`:
   \`\`\`json
   {
     "dependencies": {
       "@webpieces/NEW_PACKAGE": "*"
     }
   }
   \`\`\`

### Step 5: Update Architecture Definition
Run this command to validate and update the architecture:
\`\`\`bash
npx nx run architecture:generate
\`\`\`

This will:
- Detect any cycles (which MUST be fixed before proceeding)
- Update \`architecture/dependencies.json\` with the new dependency
- Recalculate package levels

### Step 6: Verify No Cycles
\`\`\`bash
npx nx run architecture:validate-no-architecture-cycles
\`\`\`

If cycles are detected, you MUST refactor to break the cycle. Common strategies:
- Move shared code to a lower-level package
- Use dependency inversion (interfaces in low-level, implementations in high-level)
- Restructure package boundaries

## Alternative Solutions (Preferred over adding dependencies)

### Option A: Move the Code
If you need functionality from another package, consider moving that code to a shared lower-level package.

### Option B: Dependency Inversion
Define an interface in the lower-level package, implement it in the higher-level package:
\`\`\`typescript
// In foundation package (level 0)
export interface Logger { log(msg: string): void; }

// In higher-level package
export class ConsoleLogger implements Logger { ... }
\`\`\`

### Option C: Pass Dependencies as Parameters
Instead of importing, receive the dependency as a constructor or method parameter.

## Remember
- Every dependency you add today is technical debt for tomorrow
- The best dependency is the one you don't need
- When in doubt, refactor rather than add dependencies
`;

// Module-level flag to prevent redundant file creation
let dependenciesDocCreated = false;

/**
 * Ensure a documentation file exists at the given path.
 */
function ensureDocFile(docPath: string, content: string): boolean {
    try {
        fs.mkdirSync(path.dirname(docPath), { recursive: true });
        fs.writeFileSync(docPath, content, 'utf-8');
        return true;
    } catch (err: any) {
        void err;
        console.warn(`[webpieces] Could not create doc file: ${docPath}`);
        return false;
    }
}

/**
 * Ensure the dependencies documentation file exists.
 * Called when an architecture violation is detected.
 */
function ensureDependenciesDoc(workspaceRoot: string): void {
    if (dependenciesDocCreated) return;
    const docPath = path.join(workspaceRoot, 'tmp', 'webpieces', 'webpieces.dependencies.md');
    if (ensureDocFile(docPath, DEPENDENCIES_DOC_CONTENT)) {
        dependenciesDocCreated = true;
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
 * Build set of all workspace package names (from package.json files)
 * Used to detect workspace imports (works for any scope or unscoped)
 */
function buildWorkspacePackageNames(workspaceRoot: string): Set<string> {
    const packageNames = new Set<string>();
    const mappings = buildProjectMappings(workspaceRoot);

    for (const mapping of mappings) {
        const pkgJsonPath = path.join(workspaceRoot, mapping.root, 'package.json');
        if (fs.existsSync(pkgJsonPath)) {
            try {
                const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
                if (pkgJson.name) {
                    packageNames.add(pkgJson.name);
                }
            } catch {
                // Ignore parse errors
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
            try {
                const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
                if (pkgJson.name === packageName) {
                    return mapping.name; // Return project name
                }
            } catch {
                // Ignore parse errors
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

                        // Use project name from project.json as-is (no scope forcing)
                        const projectName = projectJson.name || entry.name;

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
                "⚠️ AI Agent: READ tmp/webpieces/webpieces.dependencies.md for resolution steps!\n\n" +
                "Import '{{imported}}' violates architecture boundaries.\n\n" +
                "Project '{{project}}' (level {{level}}) can only import from:\n" +
                '{{allowedList}}',
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

                    // Build list of all allowed deps (direct + transitive) sorted by level
                    const allAllowedDeps = Array.from(allowedDeps);
                    // Sort by level (highest first) then alphabetically
                    allAllowedDeps.sort((a, b) => {
                        const levelA = graph[a]?.level ?? 0;
                        const levelB = graph[b]?.level ?? 0;
                        if (levelB !== levelA) return levelB - levelA;
                        return a.localeCompare(b);
                    });
                    const allowedList =
                        allAllowedDeps.length > 0
                            ? allAllowedDeps
                                  .map((dep) => `  - ${dep} (level ${graph[dep]?.level ?? '?'})`)
                                  .join('\n')
                            : '  (none - this is a foundation project)';

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
