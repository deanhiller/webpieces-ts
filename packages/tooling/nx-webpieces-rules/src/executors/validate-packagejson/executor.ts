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
import {
    PackageValidatorOptions,
    TestOnlyDepMode,
    validatePackageJsonDependencies,
} from '../../lib/package-validator';
import { RuleGate } from '../../lib/rule-gate';
import { toError } from '../../toError';

export interface ValidatePackageJsonOptions {
    /**
     * Strictness for "a test-only package is listed in dependencies" (i.e. it lands in
     * the `pnpm deploy --prod` closure and ships to production).
     * 'error' (default) | 'warn' (migration) | 'off'.
     */
    testOnlyDepMode?: TestOnlyDepMode;
}

export interface ExecutorResult {
    success: boolean;
}

export default async function runExecutor(
    options: ValidatePackageJsonOptions,
    context: ExecutorContext
): Promise<ExecutorResult> {
    const workspaceRoot = context.root;

    // All-or-nothing (honorEpoch = false): there is no blessed baseline to grandfather against.
    if (new RuleGate().isDisabled(workspaceRoot, 'validate-packagejson', false)) {
        return { success: true };
    }

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
        const validatorOptions = new PackageValidatorOptions(options.testOnlyDepMode ?? 'error');
        const packageValidation = await validatePackageJsonDependencies(
            enhancedGraph,
            workspaceRoot,
            validatorOptions
        );

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
            console.error('  1. Review each error above — it names the SECTION the dependency belongs in');
            console.error('  2. Imported by production source → package.json "dependencies"');
            console.error('  3. Imported only by *.spec.ts / __tests__ / test configs → "devDependencies"');
            console.error('     (devDependencies are excluded from `pnpm deploy --prod`, so test-only');
            console.error('      packages never reach the production image)');
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
