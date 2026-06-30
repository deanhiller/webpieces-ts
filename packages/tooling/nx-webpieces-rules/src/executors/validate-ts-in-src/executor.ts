/**
 * Validate TypeScript Files in src/ Executor
 *
 * Two-layer rule:
 *   Layer 1: every .ts file inside an Nx project must live under src/
 *   Layer 2: every .ts file anywhere in the workspace must belong to some
 *            Nx project. Orphan files (at workspace root or in a non-project
 *            directory) fail the rule unless explicitly allowlisted.
 *
 * `excludePaths` is holistic — its bare dir names and globs exempt files
 * from BOTH layers. Defaults exempt **\/*.d.ts and **\/jest.config.ts.
 *
 * Only the files changed vs the base branch are validated (MODIFIED_FILES),
 * so the rule applies cleanly to legacy projects — pre-existing orphan files
 * are grandfathered and only newly-touched files are checked.
 *
 * Configurable via webpieces.config.json:
 *   "validate-ts-in-src": {
 *       "mode": "MODIFIED_FILES", // "OFF" disables the rule
 *       "excludePaths": [...],   // dir names + globs, e.g. "**\/codegen.ts"
 *       "allowedRootFiles": [...]
 *   }
 *
 * Usage: nx run architecture:validate-ts-in-src
 */

import type { ExecutorContext } from '@nx/devkit';
import { createProjectGraphAsync, readProjectsConfigurationFromProjectGraph } from '@nx/devkit';
import { loadAndValidate, isPathExcluded, shouldSkipRule } from '@webpieces/rules-config';
import { execSync } from 'child_process';
import * as path from 'path';

export type ValidateTsInSrcMode = 'OFF' | 'MODIFIED_FILES';

export interface ValidateTsInSrcOptions {
    mode?: ValidateTsInSrcMode;
    excludePaths?: string[];
    allowedRootFiles?: string[];
    ignoreModifiedUntilEpoch?: number;
}

export interface ExecutorResult {
    success: boolean;
}

const DEFAULT_EXCLUDE_PATHS: string[] = [
    'node_modules', 'dist', '.nx', '.git',
    'architecture', 'tmp', 'scripts',
    '**/*.d.ts', '**/jest.config.ts',
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

function isTestFile(filePath: string): boolean {
    return filePath.includes('.spec.ts') ||
        filePath.includes('.test.ts') ||
        filePath.includes('__tests__/');
}

// webpieces-disable max-lines-new-methods -- Git command handling with untracked files requires multiple code paths
function getChangedTsFiles(workspaceRoot: string, base: string, head?: string): string[] {
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        const diffTarget = head ? `${base} ${head}` : base;
        const output = execSync(`git diff --name-only ${diffTarget} -- '*.ts' '*.tsx'`, {
            cwd: workspaceRoot,
            encoding: 'utf-8',
        });
        const changedFiles = output
            .trim()
            .split('\n')
            .filter((f: string) => f && !isTestFile(f));

        if (!head) {
            // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
            try {
                const untrackedOutput = execSync(`git ls-files --others --exclude-standard '*.ts' '*.tsx'`, {
                    cwd: workspaceRoot,
                    encoding: 'utf-8',
                });
                const untrackedFiles = untrackedOutput
                    .trim()
                    .split('\n')
                    .filter((f: string) => f && !isTestFile(f));
                const allFiles = new Set([...changedFiles, ...untrackedFiles]);
                return Array.from(allFiles);
            // webpieces-disable catch-error-pattern -- intentional swallow; git ls-files failure falls back to staged-only list
            } catch (err: unknown) {
                //const error = toError(err);
                return changedFiles;
            }
        }

        return changedFiles;
    // webpieces-disable catch-error-pattern -- intentional swallow; git diff failure returns empty list
    } catch (err: unknown) {
        //const error = toError(err);
        return [];
    }
}

function detectBase(workspaceRoot: string): string | null {
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        const mergeBase = execSync('git merge-base HEAD origin/main', {
            cwd: workspaceRoot,
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();

        if (mergeBase) {
            return mergeBase;
        }
    // webpieces-disable catch-error-pattern -- intentional swallow; try local main as fallback
    } catch (err: unknown) {
        //const error = toError(err);
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            const mergeBase = execSync('git merge-base HEAD main', {
                cwd: workspaceRoot,
                encoding: 'utf-8',
                stdio: ['pipe', 'pipe', 'pipe'],
            }).trim();

            if (mergeBase) {
                return mergeBase;
            }
        // webpieces-disable catch-error-pattern -- intentional swallow; no base found is handled by caller
        } catch (err2: unknown) {
            //const error2 = toError(err2);
            // Ignore
        }
    }
    return null;
}

function checkSingleFileLayerOne(
    relPath: string,
    projectRoots: string[],
    workspaceRoot: string,
    excludePaths: string[],
): LayerOneViolation | null {
    if (isPathExcluded(relPath, excludePaths)) return null;
    const fullPath = path.join(workspaceRoot, relPath);
    for (const projectRoot of projectRoots) {
        if (fullPath.startsWith(projectRoot + path.sep) || fullPath === projectRoot) {
            const relToProject = path.relative(projectRoot, fullPath);
            if (relToProject.startsWith('src' + path.sep) || relToProject === 'src') return null;
            const projectName = path.relative(workspaceRoot, projectRoot);
            return new LayerOneViolation(relPath, projectName);
        }
    }
    return null; // not in any project — that's layer 2's concern
}

function checkSingleFileLayerTwo(
    relPath: string,
    projectRoots: string[],
    workspaceRoot: string,
    allowedRootFiles: string[],
    excludePaths: string[],
): LayerTwoViolation | null {
    if (isPathExcluded(relPath, excludePaths)) return null;
    const parts = relPath.split(path.sep);
    if (parts.length === 1 && allowedRootFiles.includes(parts[0] ?? '')) return null;
    const fullPath = path.join(workspaceRoot, relPath);
    for (const projectRoot of projectRoots) {
        if (fullPath.startsWith(projectRoot + path.sep)) return null; // owned by a project
    }
    return new LayerTwoViolation(relPath);
}

function resolveMode(
    normalMode: ValidateTsInSrcMode,
    epoch: number | undefined,
    branch: string | undefined,
): ValidateTsInSrcMode {
    if (normalMode === 'OFF') {
        return normalMode;
    }
    // Honor the universal escape hatches: skip while on a named branch or until epoch.
    const skip = shouldSkipRule(epoch, branch);
    if (skip.skip) {
        console.log(`\n⏭️  Skipping validate-ts-in-src validation (${skip.reason})`);
        console.log('');
        return 'OFF';
    }
    return normalMode;
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

    console.error('\nTo fix, pick one:');
    console.error('  (a) Move the .ts file(s) into the src/ directory');
    console.error('  (b) Add a glob/dir to validate-ts-in-src.excludePaths in');
    console.error('      webpieces.config.json (e.g. "**/codegen.ts"). Defaults already');
    console.error('      exempt **/*.d.ts and **/jest.config.ts.\n');
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

async function runModifiedFilesMode(
    workspaceRoot: string,
    excludePaths: string[],
    allowedRootFiles: string[],
): Promise<ExecutorResult> {
    console.log('\n📁 Validating TypeScript files are in src/ and owned by a project (MODIFIED_FILES mode)\n');

    let base = process.env['NX_BASE'];
    const head = process.env['NX_HEAD'];

    if (!base) {
        base = detectBase(workspaceRoot) ?? undefined;
        if (!base) {
            console.log('\n⏭️  Skipping validate-ts-in-src validation (could not detect base branch)\n');
            return { success: true };
        }
    }

    console.log(`   Base: ${base}`);
    console.log(`   Head: ${head ?? 'working tree (includes uncommitted changes)'}`);
    console.log('');

    const projectRoots = await getProjectRoots(workspaceRoot);
    const changedFiles = getChangedTsFiles(workspaceRoot, base, head);

    if (changedFiles.length === 0) {
        console.log('✅ No TypeScript files changed\n');
        return { success: true };
    }

    console.log(`📂 Checking ${changedFiles.length} changed file(s)...`);

    const layerOneViolations: LayerOneViolation[] = [];
    const layerTwoViolations: LayerTwoViolation[] = [];

    for (const relPath of changedFiles) {
        const l1 = checkSingleFileLayerOne(relPath, projectRoots, workspaceRoot, excludePaths);
        if (l1) layerOneViolations.push(l1);
        const l2 = checkSingleFileLayerTwo(relPath, projectRoots, workspaceRoot, allowedRootFiles, excludePaths);
        if (l2) layerTwoViolations.push(l2);
    }

    if (layerOneViolations.length === 0 && layerTwoViolations.length === 0) {
        console.log('✅ All changed .ts files are inside a project\'s src/ directory\n');
        return { success: true };
    }

    if (layerOneViolations.length > 0) {
        reportLayerOneFailure(layerOneViolations);
    }
    if (layerTwoViolations.length > 0) {
        reportLayerTwoFailure(layerTwoViolations);
    }

    console.error('To disable: set rules["validate-ts-in-src"].mode to "OFF" in webpieces.config.json\n');
    return { success: false };
}

export default async function runExecutor(
    _nxOptions: ValidateTsInSrcOptions,
    context: ExecutorContext,
): Promise<ExecutorResult> {
    // Config comes from webpieces.config.json — same source as ai-hooks
    // and validate-code — via @webpieces/rules-config.
    const shared = loadAndValidate(context.root).resolved;
    const rule = shared.rules.get('validate-ts-in-src');

    const rawMode = (rule?.options['mode'] as ValidateTsInSrcMode | undefined) ?? 'MODIFIED_FILES';
    const epoch = rule?.options['ignoreModifiedUntilEpoch'] as number | undefined;
    const branch = rule?.options['ignoreRuleWhileOnBranch'] as string | undefined;
    const effectiveMode = resolveMode(rawMode, epoch, branch);

    if (effectiveMode === 'OFF' || (rule && rule.isOff)) {
        console.log('\n⏭️  Skipping validate-ts-in-src (mode: OFF)\n');
        return { success: true };
    }

    const workspaceRoot = context.root;
    const excludePaths =
        (rule?.options['excludePaths'] as string[] | undefined) ?? DEFAULT_EXCLUDE_PATHS;
    const allowedRootFiles =
        (rule?.options['allowedRootFiles'] as string[] | undefined) ?? DEFAULT_ALLOWED_ROOT_FILES;

    // Only MODIFIED_FILES remains once OFF is handled above — validate just the
    // files changed vs the base branch (legacy-friendly; no whole-workspace scan).
    return runModifiedFilesMode(workspaceRoot, excludePaths, allowedRootFiles);
}
