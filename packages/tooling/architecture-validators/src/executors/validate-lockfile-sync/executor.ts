/**
 * Validate Lockfile Sync Executor
 *
 * Validates that package-lock.json is not stale by comparing file timestamps.
 * If any package.json in the workspace has a newer modification time than
 * package-lock.json, the lock file is likely out of sync.
 *
 * This catches the common CI failure where `npm ci` fails because
 * a new workspace package or dependency was added to package.json
 * but `npm install` was never run to update the lock file.
 *
 * Usage:
 * nx run architecture:validate-lockfile-sync
 */

import type { ExecutorContext } from '@nx/devkit';
import { join } from 'path';
import { statSync, readdirSync, existsSync } from 'fs';

export interface ValidateLockfileSyncOptions {
    // No options needed
}

export interface ExecutorResult {
    success: boolean;
}

export default async function runExecutor(
    _options: ValidateLockfileSyncOptions,
    context: ExecutorContext,
): Promise<ExecutorResult> {
    const workspaceRoot = context.root;

    console.log('\n🔒 Validating package-lock.json is in sync\n');

    const lockfilePath = join(workspaceRoot, 'package-lock.json');
    if (!existsSync(lockfilePath)) {
        console.error('❌ package-lock.json not found at workspace root');
        return { success: false };
    }

    const lockfileMtime = statSync(lockfilePath).mtimeMs;
    const staleFiles: string[] = [];

    // Check root package.json
    const rootPkgPath = join(workspaceRoot, 'package.json');
    if (existsSync(rootPkgPath)) {
        const rootMtime = statSync(rootPkgPath).mtimeMs;
        if (rootMtime > lockfileMtime) {
            staleFiles.push('package.json');
        }
    }

    // Check all workspace package.json files under packages/ and apps/
    for (const topDir of ['packages', 'apps']) {
        const topPath = join(workspaceRoot, topDir);
        if (existsSync(topPath)) {
            collectStalePackageJsonFiles(topPath, workspaceRoot, lockfileMtime, staleFiles);
        }
    }

    if (staleFiles.length > 0) {
        console.error('❌ package-lock.json is stale! The following package.json files are newer:\n');
        for (const file of staleFiles) {
            console.error(`  ${file}`);
        }
        console.error('\nRun `npm install` to update package-lock.json, then commit it.');
        return { success: false };
    }

    console.log('✅ package-lock.json is in sync with all package.json files');
    return { success: true };
}

/**
 * Walk up to 2 levels deep under a directory, collecting package.json files
 * that are newer than the lockfile.
 */
function collectStalePackageJsonFiles(
    dir: string,
    workspaceRoot: string,
    lockfileMtime: number,
    staleFiles: string[],
): void {
    if (!existsSync(dir)) return;
    const entries = readdirSync(dir);

    for (const entry of entries) {
        if (entry === 'node_modules' || entry === 'dist' || entry === '.nx') continue;

        const entryPath = join(dir, entry);
        checkPackageJson(entryPath, workspaceRoot, lockfileMtime, staleFiles);

        // Check one more level deep (for packages/tooling/ai-hooks pattern)
        const subDir = join(dir, entry);
        if (!existsSync(subDir)) continue;

        const subEntries = readdirSync(subDir);
        for (const subEntry of subEntries) {
            if (subEntry === 'node_modules' || subEntry === 'dist') continue;
            checkPackageJson(join(subDir, subEntry), workspaceRoot, lockfileMtime, staleFiles);
        }
    }
}

function checkPackageJson(
    dir: string,
    workspaceRoot: string,
    lockfileMtime: number,
    staleFiles: string[],
): void {
    const pkgPath = join(dir, 'package.json');
    if (!existsSync(pkgPath)) return;

    const pkgMtime = statSync(pkgPath).mtimeMs;
    if (pkgMtime > lockfileMtime) {
        const relativePath = pkgPath.slice(workspaceRoot.length + 1);
        staleFiles.push(relativePath);
    }
}
