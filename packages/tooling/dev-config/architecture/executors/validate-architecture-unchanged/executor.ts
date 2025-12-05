/**
 * Validate Architecture Unchanged Executor
 *
 * Validates that the current architecture graph matches the saved blessed graph.
 * This ensures no unapproved architecture changes have been made.
 *
 * Usage:
 * nx run architecture:validate-architecture-unchanged
 */

import type { ExecutorContext } from '@nx/devkit';
import { generateGraph } from '../../lib/graph-generator';
import { sortGraphTopologically } from '../../lib/graph-sorter';
import { compareGraphs } from '../../lib/graph-comparator';
import { loadBlessedGraph, graphFileExists } from '../../lib/graph-loader';

export interface ValidateArchitectureUnchangedOptions {
    graphPath?: string;
}

export interface ExecutorResult {
    success: boolean;
}

export default async function runExecutor(
    options: ValidateArchitectureUnchangedOptions,
    context: ExecutorContext
): Promise<ExecutorResult> {
    const { graphPath } = options;
    const workspaceRoot = context.root;

    console.log('\n🔍 Validating Architecture Unchanged\n');

    try {
        // Check if saved graph exists
        if (!graphFileExists(workspaceRoot, graphPath)) {
            console.error('❌ No saved graph found at architecture/dependencies.json');
            console.error('   Run: nx run architecture:generate first');
            return { success: false };
        }

        // Step 1: Generate current graph from project.json files
        console.log('📊 Generating current dependency graph...');
        const rawGraph = await generateGraph();

        // Step 2: Topological sort (to get enhanced graph with levels)
        console.log('🔄 Computing topological layers...');
        const currentGraph = sortGraphTopologically(rawGraph);

        // Step 3: Load saved graph
        console.log('📂 Loading saved graph...');
        const savedGraph = loadBlessedGraph(workspaceRoot, graphPath);

        if (!savedGraph) {
            console.error('❌ Could not load saved graph');
            return { success: false };
        }

        // Step 4: Compare graphs
        console.log('🔍 Comparing current graph to saved graph...');
        const comparison = compareGraphs(currentGraph, savedGraph);

        if (comparison.identical) {
            console.log('✅ Architecture unchanged - current graph matches saved graph');
            return { success: true };
        } else {
            console.error('❌ Architecture has changed since last update!');
            console.error('\nDifferences:');
            console.error(comparison.summary);
            console.error('\nTo fix:');
            console.error('  1. Review the changes above');
            console.error('  2. If intentional, run: nx run architecture:generate');
            console.error('  3. Commit the updated architecture/dependencies.json');
            return { success: false };
        }
    } catch (err: unknown) {
        const error = err instanceof Error ? err : new Error(String(err));
        console.error('❌ Architecture validation failed:', error.message);
        return { success: false };
    }
}
