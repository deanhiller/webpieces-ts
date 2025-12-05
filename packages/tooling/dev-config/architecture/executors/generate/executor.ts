/**
 * Generate Executor
 *
 * Generates the architecture dependency graph and saves it to architecture/dependencies.json.
 * Also validates that package.json dependencies match project.json.
 *
 * Usage:
 * nx run architecture:generate
 */

import type { ExecutorContext } from '@nx/devkit';
import { generateGraph } from '../../lib/graph-generator';
import { sortGraphTopologically } from '../../lib/graph-sorter';
import { validatePackageJsonDependencies } from '../../lib/package-validator';
import { saveGraph } from '../../lib/graph-loader';

export interface GenerateExecutorOptions {
    graphPath?: string;
}

export interface ExecutorResult {
    success: boolean;
}

export default async function runExecutor(
    options: GenerateExecutorOptions,
    context: ExecutorContext
): Promise<ExecutorResult> {
    const { graphPath } = options;
    const workspaceRoot = context.root;

    console.log('\n📊 Architecture Graph Generator\n');

    try {
        // Step 1: Generate current graph from project.json files
        console.log('📊 Generating dependency graph from project.json files...');
        const rawGraph = await generateGraph();

        // Step 2: Topological sort (validates acyclic and assigns levels)
        console.log('🔄 Computing topological layers...');
        let enhancedGraph;
        try {
            enhancedGraph = sortGraphTopologically(rawGraph);
            console.log('✅ Graph is acyclic');
        } catch (err: unknown) {
            const error = err instanceof Error ? err : new Error(String(err));
            console.error('❌ Circular dependency detected!');
            console.error(error.message);
            return { success: false };
        }

        // Step 3: Validate package.json dependencies match
        console.log('📦 Validating package.json dependencies match project.json...');
        const packageValidation = await validatePackageJsonDependencies(enhancedGraph, workspaceRoot);

        if (!packageValidation.valid) {
            console.error('❌ Package.json validation failed!');
            for (const error of packageValidation.errors) {
                console.error(`  ${error}`);
            }
            return { success: false };
        }
        console.log('✅ Package.json dependencies match');

        // Step 4: Save the graph
        console.log('💾 Saving graph to architecture/dependencies.json...');
        saveGraph(enhancedGraph, workspaceRoot, graphPath);
        console.log('✅ Graph saved successfully');

        // Print summary
        const projectCount = Object.keys(enhancedGraph).length;
        const levels = new Set(Object.values(enhancedGraph).map((e) => e.level));
        console.log(`\n📈 Graph Summary:`);
        console.log(`   Projects: ${projectCount}`);
        console.log(`   Levels: ${levels.size} (0-${Math.max(...levels)})`);

        return { success: true };
    } catch (err: unknown) {
        const error = err instanceof Error ? err : new Error(String(err));
        console.error('❌ Graph generation failed:', error.message);
        return { success: false };
    }
}
