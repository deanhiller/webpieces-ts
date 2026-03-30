/**
 * Validate TypeScript Files in src/ Executor
 *
 * Validates that all .ts files in projects live inside the src/ directory.
 * This enforces the standard project structure where source code is in src/.
 *
 * Allowed exceptions:
 * - jest.config.ts (test configuration)
 * - tsconfig*.json (not .ts files anyway)
 * - test/ and __tests__/ directories (test files)
 * - plugin/ directory re-exports (backward compat shims)
 *
 * Usage:
 * nx run architecture:validate-ts-in-src
 */

import type { ExecutorContext } from '@nx/devkit';
import * as fs from 'fs';
import * as path from 'path';

export interface ValidateTsInSrcOptions {
    // No options needed
}

export interface ExecutorResult {
    success: boolean;
}

class Violation {
    filePath: string;
    projectName: string;

    constructor(filePath: string, projectName: string) {
        this.filePath = filePath;
        this.projectName = projectName;
    }
}

const ALLOWED_ROOT_FILES = new Set([
    'jest.config.ts',
]);

const ALLOWED_DIRS = new Set([
    'test',
    '__tests__',
    'plugin',
]);

function findProjectDirectories(workspaceRoot: string): string[] {
    const dirs: string[] = [];
    scanForProjects(workspaceRoot, workspaceRoot, dirs);
    return dirs;
}

function scanForProjects(dir: string, workspaceRoot: string, results: string[]): void {
    if (dir !== workspaceRoot) {
        const projPath = path.join(dir, 'project.json');
        if (fs.existsSync(projPath)) {
            results.push(dir);
            return;
        }
    }

    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.nx' || entry.name === '.git' || entry.name === 'architecture') continue;
        scanForProjects(path.join(dir, entry.name), workspaceRoot, results);
    }
}

function findTsFilesOutsideSrc(projectDir: string): string[] {
    const violations: string[] = [];
    const entries = fs.readdirSync(projectDir, { withFileTypes: true });

    for (const entry of entries) {
        if (entry.name === 'src' || entry.name === 'node_modules' || entry.name === 'dist') continue;

        if (entry.isFile() && entry.name.endsWith('.ts')) {
            if (ALLOWED_ROOT_FILES.has(entry.name)) continue;
            violations.push(path.join(projectDir, entry.name));
        }

        if (entry.isDirectory()) {
            if (ALLOWED_DIRS.has(entry.name)) continue;
            const tsFiles = findTsFilesRecursively(path.join(projectDir, entry.name));
            violations.push(...tsFiles);
        }
    }

    return violations;
}

function findTsFilesRecursively(dir: string): string[] {
    const results: string[] = [];
    if (!fs.existsSync(dir)) return results;

    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
        if (entry.name === 'node_modules' || entry.name === 'dist') continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isFile() && entry.name.endsWith('.ts')) {
            results.push(fullPath);
        } else if (entry.isDirectory()) {
            results.push(...findTsFilesRecursively(fullPath));
        }
    }
    return results;
}

export default async function runExecutor(
    _options: ValidateTsInSrcOptions,
    context: ExecutorContext,
): Promise<ExecutorResult> {
    const workspaceRoot = context.root;

    console.log('\n📁 Validating TypeScript files are in src/\n');

    const projectDirs = findProjectDirectories(workspaceRoot);
    const violations: Violation[] = [];

    for (const projectDir of projectDirs) {
        const projectName = path.relative(workspaceRoot, projectDir);
        const tsFiles = findTsFilesOutsideSrc(projectDir);

        for (const tsFile of tsFiles) {
            const relativePath = path.relative(workspaceRoot, tsFile);
            violations.push(new Violation(relativePath, projectName));
        }
    }

    if (violations.length === 0) {
        console.log('✅ All .ts files are inside src/ directories\n');
        return { success: true };
    }

    console.error('❌ TypeScript files found outside src/ directory!\n');
    console.error('All .ts source files must be inside the project\'s src/ directory.');
    console.error('This enforces the standard project structure:\n');
    console.error('  packages/{category}/{name}/');
    console.error('  ├── src/          ← ALL .ts files here');
    console.error('  ├── package.json');
    console.error('  ├── project.json');
    console.error('  └── tsconfig.json\n');

    for (const v of violations) {
        console.error(`  ❌ ${v.filePath}`);
    }

    console.error('\nTo fix: Move the .ts file(s) into the src/ directory\n');
    console.error('Allowed exceptions: jest.config.ts, test/, __tests__/, plugin/\n');

    return { success: false };
}
