/**
 * Validate Versions Executor
 *
 * Validates package.json versions and checks npm ci compatibility.
 * This catches peer dependency conflicts that npm ci catches but npm install doesn't.
 *
 * Usage:
 * nx run dev-config:validate-versions
 */

import type { ExecutorContext } from '@nx/devkit';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface ValidateVersionsOptions {
    // No options needed
}

export interface ExecutorResult {
    success: boolean;
}

// Find all package.json files except node_modules, dist, .nx, .angular
function findPackageJsonFiles(dir: string, basePath = ''): string[] {
    const files: string[] = [];
    const items = fs.readdirSync(dir);

    for (const item of items) {
        const fullPath = path.join(dir, item);
        const relativePath = path.join(basePath, item);

        // Skip these directories
        if (
            ['node_modules', 'dist', '.nx', '.angular', 'tmp', '.git'].includes(
                item,
            )
        ) {
            continue;
        }

        // Skip all hidden directories (starting with .)
        if (item.startsWith('.')) {
            continue;
        }

        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
            files.push(...findPackageJsonFiles(fullPath, relativePath));
        } else if (item === 'package.json') {
            files.push(fullPath);
        }
    }

    return files;
}

// Check if a version string uses semver ranges
function hasSemverRange(version: string): boolean {
    // Allow workspace protocol
    if (version.startsWith('workspace:')) {
        return false;
    }

    // Allow file: protocol (for local packages)
    if (version.startsWith('file:')) {
        return false;
    }

    // Check for common semver range patterns
    const semverPatterns = [
        /^\^/, // ^1.2.3
        /^~/, // ~1.2.3
        /^\+/, // +1.2.3
        /^\*/, // *
        /^>/, // >1.2.3
        /^</, // <1.2.3
        /^>=/, // >=1.2.3
        /^<=/, // <=1.2.3
        /\|\|/, // 1.2.3 || 2.x
        / - /, // 1.2.3 - 2.3.4
        /^\d+\.x/, // 1.x, 1.2.x
        /^latest$/, // latest
        /^next$/, // next
    ];

    return semverPatterns.some((pattern) => pattern.test(version));
}

// Validate a single package.json file for semver ranges
function validatePackageJson(filePath: string): string[] {
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const pkg = JSON.parse(content);
        const errors: string[] = [];

        // Check dependencies
        if (pkg.dependencies) {
            for (const [name, version] of Object.entries(pkg.dependencies)) {
                // Skip internal workspace packages
                if (name.startsWith('@webpieces/')) {
                    continue;
                }

                if (hasSemverRange(version as string)) {
                    errors.push(
                        `dependencies.${name}: "${version}" uses semver range (should be fixed version)`,
                    );
                }
            }
        }

        // Check devDependencies
        if (pkg.devDependencies) {
            for (const [name, version] of Object.entries(pkg.devDependencies)) {
                // Skip internal workspace packages
                if (name.startsWith('@webpieces/')) {
                    continue;
                }

                if (hasSemverRange(version as string)) {
                    errors.push(
                        `devDependencies.${name}: "${version}" uses semver range (should be fixed version)`,
                    );
                }
            }
        }

        // Check peerDependencies (these can have ranges for compatibility)
        // We don't validate peerDependencies for semver ranges since they're meant to be flexible

        return errors;
    } catch (err: any) {
        //const error = toError(err);
        return [`Failed to parse ${filePath}: ${err.message}`];
    }
}

// Check npm ci compatibility
function checkNpmCiCompatibility(workspaceRoot: string): string[] {
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        // Run npm install --package-lock-only to check for peer dependency conflicts
        // This simulates what npm ci does without actually installing
        // Use --ignore-scripts to prevent infinite recursion (avoid triggering preinstall hook)
        console.log('   Running npm dependency resolution check (10s timeout)...');
        execSync('npm install --package-lock-only --ignore-scripts 2>&1', {
            cwd: workspaceRoot,
            stdio: 'pipe',
            encoding: 'utf-8',
            timeout: 10000  // 10 second timeout
        });
        return [];
    } catch (err: any) {
        //const error = toError(err);
        // Check if it's a timeout
        if (err.killed) {
            return ['npm dependency check timed out - this might indicate a hang or network issue'];
        }

        // Parse the error output to extract peer dependency conflicts
        const output = err.stdout || err.stderr || err.message;

        // Check if it's a peer dependency error (npm error, not npm warn)
        if (output.includes('npm error') && (output.includes('ERESOLVE') || output.includes('peer'))) {
            return [output];
        }

        // If it's just warnings, not errors, we're OK
        if (output.includes('npm warn') && !output.includes('npm error')) {
            return [];
        }

        // Some other error - return it
        return [`npm dependency check failed: ${output}`];
    }
}

// Check semver ranges in all package.json files
function checkSemverRanges(workspaceRoot: string): { warnings: number } {
    console.log('\n📋 Checking for semver ranges (warnings only):');
    const packageFiles = findPackageJsonFiles(workspaceRoot);
    let semverWarnings = 0;

    for (const filePath of packageFiles) {
        const relativePath = path.relative(workspaceRoot, filePath);
        const errors = validatePackageJson(filePath);

        if (errors.length > 0) {
            console.log(`   ⚠️  ${relativePath}:`);
            for (const error of errors) {
                console.log(`      ${error}`);
            }
            semverWarnings += errors.length;
        } else {
            console.log(`   ✅ ${relativePath}`);
        }
    }

    if (semverWarnings > 0) {
        console.log(`\n   ⚠️  Note: ${semverWarnings} semver ranges found (consider using fixed versions for reproducibility)`);
    }

    return { warnings: semverWarnings };
}

export default async function runExecutor(
    _options: ValidateVersionsOptions,
    context: ExecutorContext
): Promise<ExecutorResult> {
    console.log('\n🔍 Validating Package Versions and npm ci Compatibility\n');

    const workspaceRoot = context.root;

    // Step 1: Check npm ci compatibility
    console.log('🔄 Checking npm ci compatibility (peer dependencies):');
    const npmCiErrors = checkNpmCiCompatibility(workspaceRoot);
    if (npmCiErrors.length > 0) {
        console.log('   ❌ npm ci compatibility check failed:');
        console.log('   This means "npm ci" will fail in CI even though "npm install" works locally.\n');
        for (const error of npmCiErrors) {
            const errorLines = error.split('\n').slice(0, 30);
            for (const line of errorLines) {
                console.log(`   ${line}`);
            }
            if (error.split('\n').length > 30) {
                console.log('   ... (truncated)');
            }
        }
        console.log('');
    } else {
        console.log('   ✅ npm ci compatibility check passed');
    }

    // Step 2: Check for semver ranges
    const { warnings: semverWarnings } = checkSemverRanges(workspaceRoot);
    const packageFiles = findPackageJsonFiles(workspaceRoot);

    // Summary
    console.log(`\n📊 Summary:`);
    console.log(`   npm ci compatibility: ${npmCiErrors.length === 0 ? '✅' : '❌'}`);
    console.log(`   Files checked: ${packageFiles.length}`);
    console.log(`   Semver warnings: ${semverWarnings}`);
    console.log(`   Errors: ${npmCiErrors.length}`);

    if (npmCiErrors.length > 0) {
        console.log('\n❌ VALIDATION FAILED!');
        console.log('   Fix peer dependency conflicts to avoid CI failures.\n');
        return { success: false };
    }

    console.log('\n✅ VALIDATION PASSED!');
    return { success: true };
}
