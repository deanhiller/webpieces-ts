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
import { generateReducedGraph } from '../../lib/graph-generator';
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
        // Step 1: Build the full graph from nx, then transitively reduce it (the view)
        console.log("📊 Generating dependency graph from nx's project graph...");
        const reducedGraph = await generateReducedGraph();

        // Step 2: Topological sort (to get enhanced graph with levels)
        console.log('🔄 Computing topological layers...');
        const enhancedGraph = sortGraphTopologically(reducedGraph);

        // Step 3: Validate package.json dependencies match
        console.log('📦 Validating package.json dependencies match the architecture graph...');
        const packageValidation = await validatePackageJsonDependencies(enhancedGraph, workspaceRoot);

        // Warnings never fail the build (e.g. runtime-only / peer deps).
        if (packageValidation.warnings.length > 0) {
            console.warn('\n⚠️  Package.json notices (non-fatal):');
            for (const warning of packageValidation.warnings) {
                console.warn(`  ${warning}`);
            }
        }

        if (!packageValidation.valid) {
            console.error('\n❌ Package.json validation failed!');
            console.error('\nErrors:');
            for (const error of packageValidation.errors) {
                console.error(`  ${error}`);
            }
            console.error('\nTo fix:');
            console.error('  1. Review the missing dependencies above');
            console.error('  2. Add the missing dependencies to the respective package.json files');
            return { success: false };
        }

        console.log('✅ Package.json dependencies cover the architecture graph');

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
