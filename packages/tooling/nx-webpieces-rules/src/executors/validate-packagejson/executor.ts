/**
 * Validate Package.json Executor
 *
 * Validates that package.json dependencies match project.json build dependencies.
 * This ensures the two sources of truth don't drift apart.
 *
 * Usage:
 * nx run architecture:validate-packagejson
 */

import type { ExecutorContext } from '@nx/devkit';
import { generateGraph } from '../../lib/graph-generator';
import { sortGraphTopologically } from '../../lib/graph-sorter';
import { validatePackageJsonDependencies } from '../../lib/package-validator';
import { toError } from '../../toError';

export interface ValidatePackageJsonOptions {
    // No options needed for now
}

export interface ExecutorResult {
    success: boolean;
}

export default async function runExecutor(
    options: ValidatePackageJsonOptions,
    context: ExecutorContext
): Promise<ExecutorResult> {
    const workspaceRoot = context.root;

    console.log('\n📦 Validating Package.json Dependencies\n');

    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        // Step 1: Generate current graph from project.json files
        console.log('📊 Generating dependency graph from project.json files...');
        const rawGraph = await generateGraph();

        // Step 2: Topological sort (to get enhanced graph with levels)
        console.log('🔄 Computing topological layers...');
        const enhancedGraph = sortGraphTopologically(rawGraph);

        // Step 3: Validate package.json dependencies match
        console.log('📦 Validating package.json dependencies match project.json...');
        const packageValidation = await validatePackageJsonDependencies(enhancedGraph, workspaceRoot);

        if (!packageValidation.valid) {
            console.error('❌ Package.json validation failed!');
            console.error('\nErrors:');
            for (const error of packageValidation.errors) {
                console.error(`  ${error}`);
            }
            console.error('\nTo fix:');
            console.error('  1. Review the missing dependencies above');
            console.error('  2. Add the missing dependencies to the respective package.json files');
            console.error('  3. Ensure dependencies in package.json match build.dependsOn in project.json');
            return { success: false };
        }

        console.log('✅ Package.json dependencies match project.json');

        // Print summary
        const validProjects = packageValidation.projectResults.filter(r => r.valid).length;
        const totalProjects = packageValidation.projectResults.length;
        console.log(`\n📈 Validation Summary:`);
        console.log(`   Projects validated: ${totalProjects}`);
        console.log(`   Valid: ${validProjects}`);
        console.log(`   Invalid: ${totalProjects - validProjects}`);

        return { success: true };
    } catch (err: unknown) {
        const error = toError(err);
        console.error('❌ Package.json validation failed:', error.message);
        return { success: false };
    }
}
