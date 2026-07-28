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
    ProjectValidationResult,
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

/**
 * Console reporting for the validation result.
 *
 * Extracted from `runExecutor` purely to keep that method under the max-method-lines
 * limit: it crossed 70 lines when the config gate (this branch) and the test-vs-prod
 * dependency classification (main, #481) both landed in it.
 */
class ValidationReporter {
    reportWarnings(warnings: string[]): void {
        // Warnings never fail the build (e.g. runtime-only / peer deps).
        if (warnings.length === 0) {
            return;
        }
        console.warn('\n⚠️  Package.json notices (non-fatal):');
        for (const warning of warnings) {
            console.warn(`  ${warning}`);
        }
    }

    reportErrors(errors: string[]): void {
        console.error('\n❌ Package.json validation failed!');
        console.error('\nErrors:');
        for (const error of errors) {
            console.error(`  ${error}`);
        }
        console.error('\nTo fix:');
        console.error('  1. Review each error above — it names the SECTION the dependency belongs in');
        console.error('  2. Imported by production source → package.json "dependencies"');
        console.error('  3. Imported only by *.spec.ts / __tests__ / test configs → "devDependencies"');
        console.error('     (devDependencies are excluded from `pnpm deploy --prod`, so test-only');
        console.error('      packages never reach the production image)');
    }

    reportSummary(projectResults: ProjectValidationResult[]): void {
        const validProjects = projectResults.filter(r => r.valid).length;
        const totalProjects = projectResults.length;
        console.log(`\n📈 Validation Summary:`);
        console.log(`   Projects validated: ${totalProjects}`);
        console.log(`   Valid: ${validProjects}`);
        console.log(`   Invalid: ${totalProjects - validProjects}`);
    }
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

        const reporter = new ValidationReporter();
        reporter.reportWarnings(packageValidation.warnings);

        if (!packageValidation.valid) {
            reporter.reportErrors(packageValidation.errors);
            return { success: false };
        }

        console.log('✅ Package.json dependencies cover the architecture graph');
        reporter.reportSummary(packageValidation.projectResults);

        return { success: true };
    } catch (err: unknown) {
        const error = toError(err);
        console.error('❌ Package.json validation failed:', error.message);
        return { success: false };
    }
}
