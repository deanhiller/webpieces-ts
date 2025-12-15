/**
 * Validate Versions Locked Executor
 *
 * Validates that package.json versions are:
 * 1. LOCKED (exact versions, no semver ranges like ^, ~, *)
 * 2. CONSISTENT across all package.json files (no version conflicts)
 *
 * Why locked versions matter:
 * - Micro bugs ARE introduced via patch versions (1.4.5 → 1.4.6)
 * - git bisect fails when software changes OUTSIDE of git
 * - Library upgrades must be explicit via PR/commit, not implicit drift
 *
 * Usage:
 * nx run architecture:validate-versions-locked
 */

import type { ExecutorContext } from '@nx/devkit';
import * as fs from 'fs';
import * as path from 'path';

export interface ValidateVersionsLockedOptions {
    // No options needed
}

export interface ExecutorResult {
    success: boolean;
}

// webpieces-disable max-lines-new-methods -- Existing method from renamed validate-versions file
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

// webpieces-disable max-lines-new-methods -- Existing method from renamed validate-versions file
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
                        `dependencies.${name}: "${version}" uses semver range (must be locked to exact version)`,
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
                        `devDependencies.${name}: "${version}" uses semver range (must be locked to exact version)`,
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

// Track all dependency versions across the monorepo
interface DependencyUsage {
    version: string;
    file: string;
    type: 'dependencies' | 'devDependencies';
}

// webpieces-disable max-lines-new-methods -- Collecting dependencies from all package.json files
// Collect all dependency versions from all package.json files
function collectAllDependencies(workspaceRoot: string): Map<string, DependencyUsage[]> {
    const dependencyMap = new Map<string, DependencyUsage[]>();
    const packageFiles = findPackageJsonFiles(workspaceRoot);

    for (const filePath of packageFiles) {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            const content = fs.readFileSync(filePath, 'utf-8');
            const pkg = JSON.parse(content);
            const relativePath = path.relative(workspaceRoot, filePath);

            // Collect dependencies
            if (pkg.dependencies) {
                for (const [name, version] of Object.entries(pkg.dependencies)) {
                    // Skip internal workspace packages
                    if (name.startsWith('@webpieces/')) continue;

                    const usage: DependencyUsage = {
                        version: version as string,
                        file: relativePath,
                        type: 'dependencies'
                    };

                    if (!dependencyMap.has(name)) {
                        dependencyMap.set(name, []);
                    }
                    dependencyMap.get(name)!.push(usage);
                }
            }

            // Collect devDependencies
            if (pkg.devDependencies) {
                for (const [name, version] of Object.entries(pkg.devDependencies)) {
                    // Skip internal workspace packages
                    if (name.startsWith('@webpieces/')) continue;

                    const usage: DependencyUsage = {
                        version: version as string,
                        file: relativePath,
                        type: 'devDependencies'
                    };

                    if (!dependencyMap.has(name)) {
                        dependencyMap.set(name, []);
                    }
                    dependencyMap.get(name)!.push(usage);
                }
            }
        } catch {
            // Skip files that can't be parsed
        }
    }

    return dependencyMap;
}

// webpieces-disable max-lines-new-methods -- Simple iteration logic, splitting would reduce clarity
// Check for version conflicts across package.json files
function checkVersionConflicts(workspaceRoot: string): string[] {
    console.log('\n🔍 Checking for version conflicts across package.json files:');

    const dependencyMap = collectAllDependencies(workspaceRoot);
    const conflicts: string[] = [];

    for (const [packageName, usages] of dependencyMap.entries()) {
        // Get unique versions (ignoring workspace: and file: protocols)
        const versions = new Set(
            usages
                .map(u => u.version)
                .filter(v => !v.startsWith('workspace:') && !v.startsWith('file:'))
        );

        if (versions.size > 1) {
            const conflictDetails = usages
                .filter(u => !u.version.startsWith('workspace:') && !u.version.startsWith('file:'))
                .map(u => `      ${u.file} (${u.type}): ${u.version}`)
                .join('\n');

            conflicts.push(`   ❌ ${packageName} has ${versions.size} different versions:\n${conflictDetails}`);
        }
    }

    if (conflicts.length === 0) {
        console.log('   ✅ No version conflicts found');
    } else {
        for (const conflict of conflicts) {
            console.log(conflict);
        }
    }

    return conflicts;
}

/**
 * Prints the educational message explaining why semver ranges are forbidden.
 * This helps developers understand the rationale behind locked versions.
 */
// webpieces-disable max-lines-new-methods -- Educational message template, splitting reduces clarity
function printSemverRangeEducationalMessage(semverErrors: number): void {
    console.log(`
❌ SEMVER RANGES DETECTED - BUILD FAILED

Found ${semverErrors} package(s) using semver ranges (^, ~, *, etc.) instead of locked versions.

WHY THIS IS A HARD FAILURE:
═══════════════════════════════════════════════════════════════════════════════

1. MICRO BUGS ARE REAL
   Thinking that patch versions (1.4.5 → 1.4.6) don't introduce bugs is wrong.
   They do. Sometimes what looks like an "easy fix" breaks things in subtle ways.

2. GIT BISECT BECOMES USELESS
   When you run "git bisect" to find when a bug was introduced, it fails if
   software changed OUTSIDE of git. You checkout an old commit, but node_modules
   has different versions than when that commit was made. The bug persists even
   in "known good" commits because the library versions drifted.

3. THE "MAGIC BUG" PROBLEM
   You checkout code from 6 months ago to debug an issue. The bug is still there!
   But it wasn't there 6 months ago... The culprit: a minor version upgrade that
   happened silently without any PR or git commit. Impossible to track down.

4. CHANGES OUTSIDE GIT = BAD
   Every change to your software should be tracked in version control.
   Implicit library upgrades via semver ranges violate this principle.

THE SOLUTION:
═══════════════════════════════════════════════════════════════════════════════

Use LOCKED (exact) versions for all dependencies:
  ❌ "lodash": "^4.17.21"    <- BAD: allows 4.17.22, 4.18.0, etc.
  ❌ "lodash": "~4.17.21"    <- BAD: allows 4.17.22, 4.17.23, etc.
  ✅ "lodash": "4.17.21"     <- GOOD: locked to this exact version

To upgrade libraries, use an explicit process:
  1. Run: npm update <package-name>
  2. Test thoroughly
  3. Commit the package.json AND package-lock.json changes
  4. Create a PR so the upgrade is reviewed and tracked in git history

This way, every library change is:
  • Intentional (not accidental)
  • Reviewed (via PR)
  • Tracked (in git history)
  • Bisectable (git bisect works correctly)

`);
}

// Check semver ranges in all package.json files - FAILS if any found
function checkSemverRanges(workspaceRoot: string): { errors: number } {
    console.log('\n📋 Checking for unlocked versions (semver ranges):');
    const packageFiles = findPackageJsonFiles(workspaceRoot);
    let semverErrors = 0;

    for (const filePath of packageFiles) {
        const relativePath = path.relative(workspaceRoot, filePath);
        const errors = validatePackageJson(filePath);

        if (errors.length > 0) {
            console.log(`   ❌ ${relativePath}:`);
            for (const error of errors) {
                console.log(`      ${error}`);
            }
            semverErrors += errors.length;
        } else {
            console.log(`   ✅ ${relativePath}`);
        }
    }

    return { errors: semverErrors };
}

export default async function runExecutor(
    _options: ValidateVersionsLockedOptions,
    context: ExecutorContext
): Promise<ExecutorResult> {
    console.log('\n🔒 Validating Package Versions are LOCKED and CONSISTENT\n');

    const workspaceRoot = context.root;

    // Step 1: Check for semver ranges (FAILS if any found)
    const { errors: semverErrors } = checkSemverRanges(workspaceRoot);
    const packageFiles = findPackageJsonFiles(workspaceRoot);

    // Step 2: Check for version conflicts across package.json files
    const versionConflicts = checkVersionConflicts(workspaceRoot);

    // Summary
    console.log(`\n📊 Summary:`);
    console.log(`   Files checked: ${packageFiles.length}`);
    console.log(`   Unlocked versions (semver ranges): ${semverErrors}`);
    console.log(`   Version conflicts: ${versionConflicts.length}`);

    // Fail on semver ranges with educational message
    if (semverErrors > 0) {
        printSemverRangeEducationalMessage(semverErrors);
        return { success: false };
    }

    // Fail on version conflicts
    if (versionConflicts.length > 0) {
        console.log('\n❌ VALIDATION FAILED!');
        console.log('   Fix version conflicts - all package.json files must use the same version for each dependency.');
        console.log('   This prevents "works on my machine" bugs where different projects use different library versions.\n');
        return { success: false };
    }

    console.log('\n✅ VALIDATION PASSED! All versions are locked and consistent.');
    return { success: true };
}
