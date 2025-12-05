/**
 * Validate No Skip-Level Dependencies Executor
 *
 * Validates that no project has redundant transitive dependencies.
 * If project A depends on B, and B transitively brings in C, then A should NOT
 * also directly depend on C (it's redundant and clutters the dependency graph).
 *
 * This keeps the architecture graph clean for visualization and human understanding.
 *
 * Usage:
 * nx run architecture:validate-no-skiplevel-deps
 */

import type { ExecutorContext } from '@nx/devkit';
import { generateGraph } from '../../lib/graph-generator';
import * as fs from 'fs';
import * as path from 'path';

export interface ValidateNoSkipLevelDepsOptions {
    // No options needed
}

export interface ExecutorResult {
    success: boolean;
}

interface RedundantDep {
    project: string;
    redundantDep: string;
    alreadyBroughtInBy: string;
}

const TRANSITIVE_DEPS_DOC = `# AI Agent Instructions: Redundant Transitive Dependency Violation

**READ THIS FILE FIRST before making any changes!**

## Why This Rule Exists

This rule keeps the architecture dependency graph **CLEAN and SIMPLE**.

When you run \`npx nx run architecture:visualize\`, it generates a visual diagram of all
package dependencies. Without this rule, you end up with a tangled mess of 100+ lines
where everything depends on everything - making it impossible to understand.

**Clean graphs = easier understanding for humans AND AI agents.**

## Understanding the Error

You have a **redundant transitive dependency**. This means:

1. Project A directly depends on Project C
2. BUT Project A also depends on Project B
3. AND Project B already brings in Project C (transitively)

Therefore, Project A's direct dependency on C is **redundant** - it's already available
through B. This extra line clutters the dependency graph.

**Example:**
\`\`\`
http-server depends on: [http-routing, http-filters, core-util]
                                         ^^^^^^^^^    ^^^^^^^^
                                         REDUNDANT!   REDUNDANT!

Why? Because http-routing already brings in:
  - http-filters (direct)
  - core-util (via http-api)
\`\`\`

## How to Fix

### Step 1: Identify the Redundant Dependency

Look at the error message. It tells you:
- Which project has the problem
- Which dependency is redundant
- Which other dependency already brings it in

### Step 2: Remove from project.json

Remove the redundant dependency from \`build.dependsOn\`:

\`\`\`json
{
  "targets": {
    "build": {
      "dependsOn": [
        "^build",
        "http-routing:build"
        // REMOVE: "http-filters:build"  <-- redundant, http-routing brings it in
        // REMOVE: "core-util:build"     <-- redundant, http-routing brings it in
      ]
    }
  }
}
\`\`\`

### Step 3: Remove from package.json

Remove the redundant dependency from \`dependencies\`:

\`\`\`json
{
  "dependencies": {
    "@webpieces/http-routing": "*"
    // REMOVE: "@webpieces/http-filters": "*"  <-- redundant
    // REMOVE: "@webpieces/core-util": "*"     <-- redundant
  }
}
\`\`\`

### Step 4: Regenerate Architecture

\`\`\`bash
npx nx run architecture:generate
\`\`\`

### Step 5: Verify

\`\`\`bash
npm run build-all
\`\`\`

## Important Notes

- You DON'T lose access to the transitive dependency - it's still available through the parent
- This is about keeping the DECLARED dependencies minimal and clean
- The actual runtime/compile behavior is unchanged
- TypeScript will still find the types through the transitive path

## Remember

- Fewer lines in the graph = easier to understand
- Only declare what you DIRECTLY need that isn't already transitively available
- When in doubt, check with \`npx nx run architecture:visualize\`
`;

/**
 * Compute all transitive dependencies for a project
 */
function computeTransitiveDeps(
    project: string,
    graph: Record<string, string[]>,
    visited: Set<string> = new Set()
): Set<string> {
    const result = new Set<string>();

    if (visited.has(project)) {
        return result;
    }
    visited.add(project);

    const directDeps = graph[project] || [];
    for (const dep of directDeps) {
        result.add(dep);
        // Recursively get transitive deps
        const transitive = computeTransitiveDeps(dep, graph, visited);
        for (const t of transitive) {
            result.add(t);
        }
    }

    return result;
}

/**
 * Find redundant dependencies for a project
 */
function findRedundantDeps(
    project: string,
    graph: Record<string, string[]>
): RedundantDep[] {
    const redundant: RedundantDep[] = [];
    const directDeps = graph[project] || [];

    // For each direct dependency, compute what it transitively brings in
    const transitiveByDep = new Map<string, Set<string>>();
    for (const dep of directDeps) {
        transitiveByDep.set(dep, computeTransitiveDeps(dep, graph));
    }

    // Check if any direct dependency is already brought in by another
    for (const dep of directDeps) {
        for (const [otherDep, otherTransitive] of transitiveByDep) {
            if (otherDep !== dep && otherTransitive.has(dep)) {
                redundant.push({
                    project,
                    redundantDep: dep,
                    alreadyBroughtInBy: otherDep,
                });
                break; // Only report once per redundant dep
            }
        }
    }

    return redundant;
}

/**
 * Write documentation file when violations are found
 */
function writeDocFile(workspaceRoot: string): void {
    const docPath = path.join(workspaceRoot, 'tmp', 'webpieces', 'webpieces.transitivedeps.md');
    const docDir = path.dirname(docPath);

    try {
        fs.mkdirSync(docDir, { recursive: true });
        fs.writeFileSync(docPath, TRANSITIVE_DEPS_DOC, 'utf-8');
    } catch (err: any) {
        void err;
        console.warn(`Could not write documentation file: ${docPath}`);
    }
}

export default async function runExecutor(
    _options: ValidateNoSkipLevelDepsOptions,
    context: ExecutorContext
): Promise<ExecutorResult> {
    console.log('\n🔄 Validating No Skip-Level Dependencies\n');

    try {
        // Step 1: Generate current graph from project.json files
        console.log('📊 Generating dependency graph from project.json files...');
        const graph = await generateGraph();

        // Step 2: Find all redundant dependencies
        console.log('🔍 Checking for redundant transitive dependencies...');
        const allRedundant: RedundantDep[] = [];

        for (const project of Object.keys(graph)) {
            const redundant = findRedundantDeps(project, graph);
            allRedundant.push(...redundant);
        }

        if (allRedundant.length === 0) {
            console.log('✅ No redundant transitive dependencies detected!');
            console.log('\n📈 Graph is clean and minimal.');
            return { success: true };
        }

        // Write documentation file
        const workspaceRoot = context.root || process.cwd();
        writeDocFile(workspaceRoot);

        // Report violations
        console.error('\n❌ Redundant transitive dependencies detected!\n');
        console.error('⚠️  AI Agent: READ tmp/webpieces/webpieces.transitivedeps.md for fix instructions!\n');

        for (const r of allRedundant) {
            console.error(`  ${r.project}:`);
            console.error(`    └─ "${r.redundantDep}" is REDUNDANT`);
            console.error(`       (already brought in by "${r.alreadyBroughtInBy}")\n`);
        }

        console.error('\nTo fix:');
        console.error('  1. READ tmp/webpieces/webpieces.transitivedeps.md');
        console.error('  2. Remove redundant deps from project.json build.dependsOn');
        console.error('  3. Remove redundant deps from package.json dependencies');
        console.error('  4. Run: npx nx run architecture:generate');
        console.error('  5. Run: npm run build-all');

        return { success: false };
    } catch (err: any) {
        const error = err instanceof Error ? err : new Error(String(err));
        console.error('❌ Skip-level validation failed:', error.message);
        return { success: false };
    }
}
