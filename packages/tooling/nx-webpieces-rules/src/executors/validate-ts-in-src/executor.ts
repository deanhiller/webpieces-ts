/**
 * Validate TypeScript Files in src/ Executor
 *
 * Two-layer rule:
 *   Layer 1: every .ts file inside an Nx project must live under src/
 *            (jest.config.ts at project root is the only exception)
 *   Layer 2: every .ts file anywhere in the workspace must belong to some
 *            Nx project. Orphan files (at workspace root or in a non-project
 *            directory) fail the rule unless explicitly allowlisted.
 *
 * Configurable via nx.json targetDefaults:
 *   "validate-ts-in-src": {
 *       "options": {
 *           "mode": "ON",
 *           "excludePaths": [...],
 *           "allowedRootFiles": [...]
 *       }
 *   }
 *
 * Usage: nx run architecture:validate-ts-in-src
 */

import type { ExecutorContext } from '@nx/devkit';
import { createProjectGraphAsync, readProjectsConfigurationFromProjectGraph } from '@nx/devkit';
import { loadConfig } from '@webpieces/rules-config';
import * as fs from 'fs';
import * as path from 'path';

export type ValidateTsInSrcMode = 'ON' | 'OFF';

export interface ValidateTsInSrcOptions {
    mode?: ValidateTsInSrcMode;
    excludePaths?: string[];
    allowedRootFiles?: string[];
}

export interface ExecutorResult {
    success: boolean;
}

const DEFAULT_EXCLUDE_PATHS: string[] = [
    'node_modules', 'dist', '.nx', '.git',
    'architecture', 'tmp', 'scripts',
];

const DEFAULT_ALLOWED_ROOT_FILES: string[] = ['jest.setup.ts'];

class LayerOneViolation {
    filePath: string;
    projectName: string;

    constructor(filePath: string, projectName: string) {
        this.filePath = filePath;
        this.projectName = projectName;
    }
}

class LayerTwoViolation {
    filePath: string;

    constructor(filePath: string) {
        this.filePath = filePath;
    }
}

function isNodeModulesDir(name: string): boolean {
    return name === 'node_modules' || name.startsWith('node_modules_');
}

function shouldSkipTopLevelDir(name: string, excludePaths: string[]): boolean {
    if (isNodeModulesDir(name)) return true;
    return excludePaths.includes(name);
}

async function getProjectRoots(workspaceRoot: string): Promise<string[]> {
    const projectGraph = await createProjectGraphAsync();
    const projectsConfig = readProjectsConfigurationFromProjectGraph(projectGraph);
    const roots: string[] = [];
    for (const cfg of Object.values(projectsConfig.projects)) {
        if (cfg.root === '' || cfg.root === '.') continue;
        if (cfg.root === 'architecture') continue;
        roots.push(path.join(workspaceRoot, cfg.root));
    }
    return roots;
}

function findTsFilesOutsideSrc(projectDir: string): string[] {
    const violations: string[] = [];
    if (!fs.existsSync(projectDir)) return violations;
    const entries = fs.readdirSync(projectDir, { withFileTypes: true });

    for (const entry of entries) {
        if (entry.name === 'src') continue;
        if (isNodeModulesDir(entry.name)) continue;
        if (entry.name === 'dist') continue;

        if (entry.isFile() && entry.name.endsWith('.ts')) {
            if (entry.name === 'jest.config.ts') continue;
            violations.push(path.join(projectDir, entry.name));
        }

        if (entry.isDirectory()) {
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
        if (isNodeModulesDir(entry.name)) continue;
        if (entry.name === 'dist') continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isFile() && entry.name.endsWith('.ts')) {
            results.push(fullPath);
        } else if (entry.isDirectory()) {
            results.push(...findTsFilesRecursively(fullPath));
        }
    }
    return results;
}

function findOrphanTsFiles(
    dir: string,
    projectRootSet: Set<string>,
    workspaceRoot: string,
    results: string[],
): void {
    if (!fs.existsSync(dir)) return;

    const relDir = path.relative(workspaceRoot, dir);
    if (projectRootSet.has(relDir)) return;

    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
        if (isNodeModulesDir(entry.name)) continue;
        if (entry.name === 'dist') continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isFile() && entry.name.endsWith('.ts')) {
            results.push(fullPath);
        } else if (entry.isDirectory()) {
            findOrphanTsFiles(fullPath, projectRootSet, workspaceRoot, results);
        }
    }
}

function checkLayerOne(projectRoots: string[], workspaceRoot: string): LayerOneViolation[] {
    const violations: LayerOneViolation[] = [];
    for (const projectDir of projectRoots) {
        const projectName = path.relative(workspaceRoot, projectDir);
        const tsFiles = findTsFilesOutsideSrc(projectDir);
        for (const tsFile of tsFiles) {
            const relativePath = path.relative(workspaceRoot, tsFile);
            violations.push(new LayerOneViolation(relativePath, projectName));
        }
    }
    return violations;
}

function checkLayerTwo(
    workspaceRoot: string,
    projectRoots: string[],
    excludePaths: string[],
    allowedRootFiles: string[],
): LayerTwoViolation[] {
    const violations: LayerTwoViolation[] = [];
    const projectRootSet = new Set(
        projectRoots.map((p) => path.relative(workspaceRoot, p)),
    );

    const entries = fs.readdirSync(workspaceRoot, { withFileTypes: true });

    for (const entry of entries) {
        if (entry.isFile()) {
            if (!entry.name.endsWith('.ts')) continue;
            if (allowedRootFiles.includes(entry.name)) continue;
            violations.push(new LayerTwoViolation(entry.name));
            continue;
        }
        if (!entry.isDirectory()) continue;
        if (shouldSkipTopLevelDir(entry.name, excludePaths)) continue;

        const orphans: string[] = [];
        findOrphanTsFiles(
            path.join(workspaceRoot, entry.name),
            projectRootSet,
            workspaceRoot,
            orphans,
        );
        for (const orphan of orphans) {
            violations.push(new LayerTwoViolation(path.relative(workspaceRoot, orphan)));
        }
    }

    return violations;
}

function reportLayerOneFailure(violations: LayerOneViolation[]): void {
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

    console.error('\nTo fix: Move the .ts file(s) into the src/ directory');
    console.error('Only exception: jest.config.ts at project root\n');
}

function reportLayerTwoFailure(violations: LayerTwoViolation[]): void {
    console.error('❌ TypeScript files found outside any Nx project!\n');
    console.error('Every .ts file must belong to an Nx project so it is compiled,');
    console.error('linted, and tested under a known project config. Orphan files are');
    console.error('invisible to the build graph and will rot.\n');

    for (const v of violations) {
        console.error(`  ❌ ${v.filePath}`);
    }

    console.error('\nTo fix, pick one:');
    console.error('  (a) Move the file into an existing project\'s src/ directory');
    console.error('  (b) Create a new project (add project.json) that owns the directory');
    console.error('  (c) Add the containing top-level directory to validate-ts-in-src.excludePaths');
    console.error('      in nx.json targetDefaults, or add the filename to allowedRootFiles');
    console.error('      if it is a legitimate workspace-root file (e.g., jest.setup.ts)\n');
}

export default async function runExecutor(
    _nxOptions: ValidateTsInSrcOptions,
    context: ExecutorContext,
): Promise<ExecutorResult> {
    // Config comes from webpieces.config.json — same source as ai-hooks
    // and validate-code — via @webpieces/rules-config.
    const shared = loadConfig(context.root);
    const rule = shared.rules.get('validate-ts-in-src');

    if (rule && rule.enabled === false) {
        console.log('\n⏭️  Skipping validate-ts-in-src (enabled: false)\n');
        return { success: true };
    }

    const workspaceRoot = context.root;
    const excludePaths =
        (rule?.options['excludePaths'] as string[] | undefined) ?? DEFAULT_EXCLUDE_PATHS;
    const allowedRootFiles =
        (rule?.options['allowedRootFiles'] as string[] | undefined) ?? DEFAULT_ALLOWED_ROOT_FILES;

    console.log('\n📁 Validating TypeScript files are in src/ and owned by a project\n');

    const projectRoots = await getProjectRoots(workspaceRoot);

    const layerOneViolations = checkLayerOne(projectRoots, workspaceRoot);
    const layerTwoViolations = checkLayerTwo(
        workspaceRoot, projectRoots, excludePaths, allowedRootFiles,
    );

    if (layerOneViolations.length === 0 && layerTwoViolations.length === 0) {
        console.log('✅ All .ts files are inside a project\'s src/ directory\n');
        return { success: true };
    }

    if (layerOneViolations.length > 0) {
        reportLayerOneFailure(layerOneViolations);
    }
    if (layerTwoViolations.length > 0) {
        reportLayerTwoFailure(layerTwoViolations);
    }

    console.error('To disable: set rules["validate-ts-in-src"].enabled to false in webpieces.config.json\n');
    return { success: false };
}
