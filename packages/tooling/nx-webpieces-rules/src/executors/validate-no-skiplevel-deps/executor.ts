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
import { writeTemplate } from '@webpieces/rules-config';
import { toError } from '../../toError';

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
    const transitiveEntries = Array.from(transitiveByDep.entries());
    for (const dep of directDeps) {
        for (const entry of transitiveEntries) {
            const otherDep = entry[0];
            const otherTransitive = entry[1];
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
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        writeTemplate(workspaceRoot, 'webpieces.transitivedeps.md');
    } catch (err: unknown) {
        const error = toError(err);
        console.warn('Could not write webpieces.transitivedeps.md:', error.message);
    }
}

export default async function runExecutor(
    _options: ValidateNoSkipLevelDepsOptions,
    context: ExecutorContext
): Promise<ExecutorResult> {
    console.log('\n🔄 Validating No Skip-Level Dependencies\n');

    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
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
        console.error('⚠️  AI Agent: READ .webpieces/instruct-ai/webpieces.transitivedeps.md for fix instructions!\n');

        for (const r of allRedundant) {
            console.error(`  ${r.project}:`);
            console.error(`    └─ "${r.redundantDep}" is REDUNDANT`);
            console.error(`       (already brought in by "${r.alreadyBroughtInBy}")\n`);
        }

        console.error('\nTo fix:');
        console.error('  1. READ .webpieces/instruct-ai/webpieces.transitivedeps.md');
        console.error('  2. Remove redundant deps from project.json build.dependsOn');
        console.error('  3. Remove redundant deps from package.json dependencies');
        console.error('  4. Run: npx nx run architecture:generate');
        console.error('  5. Run: npm run build-all');

        return { success: false };
    } catch (err: unknown) {
        const error = toError(err);
        console.error('❌ Skip-level validation failed:', error.message);
        return { success: false };
    }
}
