/**
 * Validate No Cycles Executor
 *
 * Validates that the architecture dependency graph has no circular dependencies.
 * This is a fast check that only validates acyclicity.
 *
 * Usage:
 * nx run architecture:validate-no-cycles
 */

import type { ExecutorContext } from '@nx/devkit';
import { generateGraph } from '../../lib/graph-generator';
import { sortGraphTopologically } from '../../lib/graph-sorter';

export interface ValidateNoCyclesOptions {
    // No options needed
}

export interface ExecutorResult {
    success: boolean;
}

export default async function runExecutor(
    _options: ValidateNoCyclesOptions,
    _context: ExecutorContext
): Promise<ExecutorResult> {
    console.log('\n🔄 Validating No Circular Dependencies\n');

    try {
        // Step 1: Generate current graph from project.json files
        console.log('📊 Generating dependency graph from project.json files...');
        const rawGraph = await generateGraph();

        // Step 2: Topological sort (validates acyclic)
        console.log('🔄 Checking for cycles (topological sort)...');
        try {
            sortGraphTopologically(rawGraph);
            console.log('✅ No circular dependencies detected!');

            // Print summary
            const projectCount = Object.keys(rawGraph).length;
            console.log(`\n📈 Summary: ${projectCount} projects, all acyclic`);

            return { success: true };
        } catch (err: unknown) {
            const error = err instanceof Error ? err : new Error(String(err));
            console.error('❌ Circular dependency detected!');
            console.error(error.message);
            console.error('\nTo fix:');
            console.error('  1. Review the cycle above');
            console.error('  2. Break the cycle by refactoring dependencies');
            console.error('  3. Run this check again');
            return { success: false };
        }
    } catch (err: unknown) {
        const error = err instanceof Error ? err : new Error(String(err));
        console.error('❌ Cycle validation failed:', error.message);
        return { success: false };
    }
}
