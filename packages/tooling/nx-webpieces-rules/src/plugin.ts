/**
 * Unified Nx Inference Plugin for @webpieces/nx-webpieces-rules
 *
 * This plugin automatically creates targets for:
 * 1. Workspace-level architecture validation (generate, visualize, validate-*)
 * 2. Per-project circular dependency checking
 *
 * Install with: nx add @webpieces/nx-webpieces-rules
 *
 * Usage:
 * Add to nx.json plugins array:
 * {
 *   "plugins": ["@webpieces/nx-webpieces-rules"]
 * }
 *
 * Then all targets appear automatically without manual project.json configuration.
 */

import { dirname, join } from 'path';
import { existsSync } from 'fs';
import type {
    CreateNodesV2,
    CreateNodesContextV2,
    CreateNodesResultV2,
    CreateNodesResult,
    TargetConfiguration,
} from '@nx/devkit';
import {
    createVisualizeRuntimeTarget,
    createValidateRuntimeArchitectureTarget,
    createValidateRuntimeMarkersTarget,
} from './runtime-targets';
import {
    createDiGraphGenerateTarget,
    createValidateDiGraphUnchangedTarget,
} from './di-graph-targets';

/**
 * Circular dependency checking options
 */
export interface CircularDepsOptions {
    enabled?: boolean;
    targetName?: string;
    excludePatterns?: string[];
}

/**
 * Validation options for architecture checks
 */
export interface ValidationOptions {
    noCycles?: boolean;
    noSkipLevelDeps?: boolean;
    architectureUnchanged?: boolean;
    validatePackageJson?: boolean;
    validateNewMethods?: boolean;
    validateModifiedMethods?: boolean;
    validateModifiedFiles?: boolean;
    validateVersionsLocked?: boolean;
    validateTsInSrc?: boolean;
    validateNxWiring?: boolean;
    runtimeArchitecture?: boolean;
    diGraph?: boolean;
    newMethodsMaxLines?: number;
    modifiedAndNewMethodsMaxLines?: number;
    modifiedFilesMaxLines?: number;
    /**
     * Validation mode for method/file size limits:
     * - STRICT: All limits enforced, disable comments ignored
     * - NORMAL: Limits enforced, disable comments with dates work
     * - OFF: Skip size validations entirely (for fast iteration)
     */
    validationMode?: 'STRICT' | 'NORMAL' | 'OFF';
}

/**
 * Feature flags for workspace targets
 */
export interface FeatureOptions {
    generate?: boolean;
    visualize?: boolean;
    visualizeRuntime?: boolean;
}

/**
 * Workspace-level configuration options
 */
export interface WorkspaceOptions {
    enabled?: boolean;
    targetPrefix?: string;
    graphPath?: string;
    validations?: ValidationOptions;
    features?: FeatureOptions;
}

/**
 * Configuration for @webpieces/nx-webpieces-rules Nx plugin
 */
export interface ArchitecturePluginOptions {
    circularDeps?: CircularDepsOptions;
    workspace?: WorkspaceOptions;
}

const DEFAULT_OPTIONS: Required<ArchitecturePluginOptions> = {
    circularDeps: {
        enabled: true,
        targetName: 'validate-no-file-import-cycles',
        excludePatterns: [],
    },
    workspace: {
        enabled: true,
        targetPrefix: 'arch:',
        graphPath: 'architecture/dependencies.json',
        validations: {
            noCycles: true,
            // Retired: the architecture graph is now auto-reduced in `generate`, so the
            // committed graph can never contain a skip-level edge. Defaults off; the
            // executor is a no-op kept for one release. See validate-no-skiplevel-deps.
            noSkipLevelDeps: false,
            architectureUnchanged: true,
            validatePackageJson: true,
            validateNewMethods: true,
            validateModifiedMethods: true,
            validateModifiedFiles: true,
            validateVersionsLocked: true,
            validateTsInSrc: true,
            validateNxWiring: true,
            runtimeArchitecture: true,
            diGraph: true,
            newMethodsMaxLines: 30,
            modifiedAndNewMethodsMaxLines: 80,
            modifiedFilesMaxLines: 900,
            validationMode: 'NORMAL',
        },
        features: {
            generate: true,
            visualize: true,
            visualizeRuntime: true,
        },
    },
};

function normalizeOptions(
    options: ArchitecturePluginOptions | undefined,
): Required<ArchitecturePluginOptions> {
    const circularDeps = {
        ...DEFAULT_OPTIONS.circularDeps,
        ...options?.circularDeps,
    };

    const workspace = {
        ...DEFAULT_OPTIONS.workspace,
        ...options?.workspace,
        validations: {
            ...DEFAULT_OPTIONS.workspace.validations,
            ...options?.workspace?.validations,
        },
        features: {
            ...DEFAULT_OPTIONS.workspace.features,
            ...options?.workspace?.features,
        },
    };

    return {
        circularDeps,
        workspace,
    } as Required<ArchitecturePluginOptions>;
}

async function createNodesFunction(
    projectFiles: readonly string[],
    options: ArchitecturePluginOptions | undefined,
    context: CreateNodesContextV2,
): Promise<CreateNodesResultV2> {
    const opts = normalizeOptions(options);
    const results: CreateNodesResultV2 = [];

    // Add workspace-level architecture targets
    addArchitectureProject(results, projectFiles, opts, context);

    // Add per-project targets (circular-deps, ci, runtime-markers)
    addPerProjectTargets(results, projectFiles, opts, context);

    return results;
}

function addArchitectureProject(
    results: CreateNodesResultV2,
    projectFiles: readonly string[],
    opts: Required<ArchitecturePluginOptions>,
    context: CreateNodesContextV2,
): void {
    if (!opts.workspace.enabled) return;

    const archDirPath = join(context.workspaceRoot, 'architecture');
    if (!existsSync(archDirPath)) return;

    const workspaceTargets = createWorkspaceTargetsWithoutPrefix(opts);
    if (Object.keys(workspaceTargets).length === 0) return;

    const result: CreateNodesResult = {
        projects: {
            architecture: {
                name: 'architecture',
                root: 'architecture',
                targets: workspaceTargets,
            },
        },
    };

    const firstProjectFile = projectFiles[0];
    if (firstProjectFile) {
        results.push([firstProjectFile, result] as const);
    }
}


// A project sits inside a NESTED git repo (e.g. a clone under repositories/) when any of its
// ancestor dirs — up to but NOT including the workspace root — contains a `.git`. Such projects are
// separate repos, not part of THIS workspace's graph, so they must not get inferred targets (that is
// what drags foreign clones into `nx affected`). Same repo-boundary signal the AI guards use.
export function isInsideNestedGitRepo(workspaceRoot: string, projectRoot: string): boolean {
    let dir = projectRoot;
    while (dir && dir !== '.' && dir !== '/') {
        if (existsSync(join(workspaceRoot, dir, '.git'))) return true;
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return false;
}

function addPerProjectTargets(
    results: CreateNodesResultV2,
    projectFiles: readonly string[],
    opts: Required<ArchitecturePluginOptions>,
    context: CreateNodesContextV2,
): void {
    // Track processed project roots to avoid duplicates when both files exist
    const processedRoots = new Set<string>();

    for (const projectFile of projectFiles) {
        const isProjectJson = projectFile.endsWith('project.json');
        const isPackageJson = projectFile.endsWith('package.json');

        if (!isProjectJson && !isPackageJson) continue;

        const projectRoot = dirname(projectFile);

        // Skip root (workspace manifest, not a project)
        if (projectRoot === '.') continue;

        // Skip projects inside a nested git repo (vendored clones under repositories/): they are
        // separate repos and must not be swept into this workspace's `nx affected` graph.
        if (isInsideNestedGitRepo(context.workspaceRoot, projectRoot)) continue;

        // Skip if we've already processed this project root
        if (processedRoots.has(projectRoot)) continue;

        // For package.json, skip if project.json also exists in same directory
        // (prefer project.json - it will be processed separately)
        if (isPackageJson) {
            const projectJsonPath = join(context.workspaceRoot, projectRoot, 'project.json');
            if (existsSync(projectJsonPath)) continue;
        }

        processedRoots.add(projectRoot);

        const targets = buildPerProjectTargets(isProjectJson, projectRoot, opts);

        if (Object.keys(targets).length === 0) continue;

        const result: CreateNodesResult = {
            projects: {
                [projectRoot]: {
                    targets,
                },
            },
        };

        results.push([projectFile, result] as const);
    }
}

/**
 * Build the target map for one project. Most targets are project.json-only
 * (package.json-only projects may not have TypeScript source); `ci` goes on all.
 */
function buildPerProjectTargets(
    isProjectJson: boolean,
    projectRoot: string,
    opts: Required<ArchitecturePluginOptions>,
): Record<string, TargetConfiguration> {
    const targets: Record<string, TargetConfiguration> = {};

    // Add circular-deps target ONLY for project.json projects
    if (isProjectJson && opts.circularDeps.enabled) {
        if (!isExcluded(projectRoot, opts.circularDeps.excludePatterns!)) {
            const targetName = opts.circularDeps.targetName!;
            targets[targetName] = createCircularDepsTarget(projectRoot, targetName);
        }
    }

    // Add per-project runtime-marker validation (validates this project's
    // service-contract.json against its own api-project deps, independently).
    if (isProjectJson && opts.workspace.validations!.runtimeArchitecture) {
        targets['validate-runtime-markers'] = createValidateRuntimeMarkersTarget();
    }

    // Per-project DI design DAG: regenerate design.json/design.md on every build,
    // then gate the build on the committed copies being current.
    if (isProjectJson && opts.workspace.validations!.diGraph) {
        targets['di-graph-generate'] = createDiGraphGenerateTarget();
        targets['validate-di-graph-unchanged'] = createValidateDiGraphUnchangedTarget();
    }

    // Add ci target to ALL projects (both project.json and package.json)
    targets['ci'] = createCiTarget();

    return targets;
}

/**
 * Nx V2 Inference Plugin
 * Matches project.json and package.json files to create targets
 */
export const createNodesV2: CreateNodesV2<ArchitecturePluginOptions> = [
    // Pattern to match project.json and package.json files
    '**/{project,package}.json',

    // Inference function
    createNodesFunction,
];

/**
 * Build list of enabled validation target names for validate-complete dependency chain
 */
function buildValidationTargetsList(
    validations: Required<ArchitecturePluginOptions>['workspace']['validations'],
): string[] {
    const targets: string[] = [];
    if (validations!.noCycles) targets.push('validate-no-architecture-cycles');
    if (validations!.architectureUnchanged) targets.push('validate-architecture-unchanged');
    if (validations!.noSkipLevelDeps) targets.push('validate-no-skiplevel-deps');
    if (validations!.validatePackageJson) targets.push('validate-packagejson');
    // Use combined validate-code instead of 3 separate targets
    if (
        validations!.validateNewMethods ||
        validations!.validateModifiedMethods ||
        validations!.validateModifiedFiles
    ) {
        targets.push('validate-code');
    }
    if (validations!.validateVersionsLocked) targets.push('validate-versions-locked');
    if (validations!.validateTsInSrc) targets.push('validate-ts-in-src');
    if (validations!.validateNxWiring) targets.push('validate-nx-wiring');
    if (validations!.runtimeArchitecture) targets.push('validate-runtime-architecture');
    return targets;
}

/**
 * Create workspace-level architecture validation targets WITHOUT prefix
 * Used for virtual 'architecture' project
 */
function createWorkspaceTargetsWithoutPrefix(
    opts: Required<ArchitecturePluginOptions>,
): Record<string, TargetConfiguration> {
    const targets: Record<string, TargetConfiguration> = {};
    const graphPath = opts.workspace.graphPath!;
    const validations = opts.workspace.validations!;

    // Add help target (always available)
    targets['help'] = createHelpTarget();

    if (opts.workspace.features!.generate) {
        targets['generate'] = createGenerateTarget(graphPath);
    }
    if (opts.workspace.features!.visualize) {
        targets['visualize'] = createVisualizeTargetWithoutPrefix(graphPath);
    }
    if (opts.workspace.features!.visualizeRuntime) {
        targets['visualize-runtime'] = createVisualizeRuntimeTarget();
    }
    if (validations.noCycles) {
        targets['validate-no-architecture-cycles'] = createValidateNoCyclesTarget();
    }
    if (validations.architectureUnchanged) {
        targets['validate-architecture-unchanged'] = createValidateUnchangedTarget(graphPath);
    }
    if (validations.noSkipLevelDeps) {
        targets['validate-no-skiplevel-deps'] = createValidateNoSkipLevelTarget();
    }
    if (validations.validatePackageJson) {
        targets['validate-packagejson'] = createValidatePackageJsonTarget();
    }
    // Use combined validate-code instead of 3 separate targets
    // Options come from webpieces.config.json at the workspace root
    // (loaded via @webpieces/rules-config; same source of truth as @webpieces/ai-hook-rules)
    if (
        validations.validateNewMethods ||
        validations.validateModifiedMethods ||
        validations.validateModifiedFiles
    ) {
        targets['validate-code'] = createValidateCodeTarget();
    }
    if (validations.validateVersionsLocked) {
        targets['validate-versions-locked'] = createValidateVersionsLockedTarget();
    }
    if (validations.validateTsInSrc) {
        targets['validate-ts-in-src'] = createValidateTsInSrcTarget();
    }
    if (validations.validateNxWiring) {
        targets['validate-nx-wiring'] = createValidateNxWiringTarget();
    }
    if (validations.runtimeArchitecture) {
        targets['validate-runtime-architecture'] = createValidateRuntimeArchitectureTarget();
    }

    // Add validate-complete target that runs all enabled validations
    const validationTargets = buildValidationTargetsList(validations);
    if (validationTargets.length > 0) {
        targets['validate-complete'] = createValidateCompleteTarget(validationTargets);
    }

    return targets;
}

function createGenerateTarget(graphPath: string): TargetConfiguration {
    return {
        executor: '@webpieces/nx-webpieces-rules:generate',
        cache: false,
        outputs: [
            '{workspaceRoot}/architecture/dependencies.json',
            '{workspaceRoot}/architecture/dependencies.html',
            '{workspaceRoot}/architecture/runtime-dependencies.json',
        ],
        options: { graphPath },
        metadata: {
            technologies: ['nx'],
            description:
                'Generate the architecture dependency graph (+ clickable dependencies.html) and the runtime microservice graph',
        },
    };
}

function createVisualizeTargetWithoutPrefix(graphPath: string): TargetConfiguration {
    return {
        executor: '@webpieces/nx-webpieces-rules:visualize',
        dependsOn: ['generate'],
        options: { graphPath },
        metadata: {
            technologies: ['nx'],
            description: 'Generate visual representations of the architecture graph',
        },
    };
}

function createValidateNoCyclesTarget(): TargetConfiguration {
    return {
        executor: '@webpieces/nx-webpieces-rules:validate-no-architecture-cycles',
        cache: true,
        inputs: ['{workspaceRoot}/**/project.json', '{workspaceRoot}/architecture/dependencies.json'],
        metadata: {
            technologies: ['nx'],
            description: 'Validate the architecture has no circular project dependencies',
        },
    };
}

function createValidateUnchangedTarget(graphPath: string): TargetConfiguration {
    return {
        executor: '@webpieces/nx-webpieces-rules:validate-architecture-unchanged',
        cache: false,
        inputs: ['default', '{workspaceRoot}/architecture/dependencies.json'],
        options: { graphPath },
        metadata: {
            technologies: ['nx'],
            description: 'Validate the architecture matches the saved blessed graph',
        },
    };
}

function createValidateNoSkipLevelTarget(): TargetConfiguration {
    return {
        executor: '@webpieces/nx-webpieces-rules:validate-no-skiplevel-deps',
        cache: true,
        inputs: ['{workspaceRoot}/**/project.json', '{workspaceRoot}/architecture/dependencies.json'],
        metadata: {
            technologies: ['nx'],
            description: 'Validate no project has redundant transitive dependencies',
        },
    };
}

function createValidatePackageJsonTarget(): TargetConfiguration {
    return {
        executor: '@webpieces/nx-webpieces-rules:validate-packagejson',
        cache: true,
        inputs: ['{workspaceRoot}/**/project.json', '{workspaceRoot}/**/package.json'],
        metadata: {
            technologies: ['nx'],
            description: 'Validate package.json dependencies match project.json build dependencies',
        },
    };
}

function createValidateNewMethodsTarget(
    maxLines: number,
    mode: 'STRICT' | 'NORMAL' | 'OFF',
): TargetConfiguration {
    return {
        executor: '@webpieces/nx-webpieces-rules:validate-new-methods',
        cache: false, // Don't cache - depends on git state
        inputs: ['default'],
        options: { max: maxLines, mode },
        metadata: {
            technologies: ['nx'],
            description: `Validate new methods do not exceed ${maxLines} lines (only runs in affected mode)`,
        },
    };
}

function createValidateModifiedMethodsTarget(
    maxLines: number,
    mode: 'STRICT' | 'NORMAL' | 'OFF',
): TargetConfiguration {
    return {
        executor: '@webpieces/nx-webpieces-rules:validate-modified-methods',
        cache: false, // Don't cache - depends on git state
        inputs: ['default'],
        options: { max: maxLines, mode },
        metadata: {
            technologies: ['nx'],
            description: `Validate new and modified methods do not exceed ${maxLines} lines (encourages gradual cleanup)`,
        },
    };
}

function createValidateModifiedFilesTarget(
    maxLines: number,
    mode: 'STRICT' | 'NORMAL' | 'OFF',
): TargetConfiguration {
    return {
        executor: '@webpieces/nx-webpieces-rules:validate-modified-files',
        cache: false, // Don't cache - depends on git state
        inputs: ['default'],
        options: { max: maxLines, mode },
        metadata: {
            technologies: ['nx'],
            description: `Validate modified files do not exceed ${maxLines} lines (encourages keeping files small)`,
        },
    };
}

/**
 * Create combined validate-code target
 * Options come from webpieces.config.json at the workspace root
 * (loaded by the executor via @webpieces/rules-config — same source of truth as @webpieces/ai-hook-rules)
 */
function createValidateCodeTarget(): TargetConfiguration {
    return {
        executor: '@webpieces/nx-webpieces-rules:validate-code',
        cache: false, // Don't cache - depends on git state
        inputs: ['default', '{workspaceRoot}/webpieces.config.json', {'runtime': 'node -e "process.stdout.write(String(Math.random()))"'}],
        // No options here - they come from webpieces.config.json at runtime
        metadata: {
            technologies: ['nx'],
            description: 'Combined validation for new methods, modified methods, and file sizes',
        },
    };
}

function createValidateVersionsLockedTarget(): TargetConfiguration {
    return {
        executor: '@webpieces/nx-webpieces-rules:validate-versions-locked',
        cache: true,
        inputs: ['{workspaceRoot}/**/package.json'],
        metadata: {
            technologies: ['nx'],
            description:
                'Validate package.json versions are locked (no semver ranges) and consistent across projects',
        },
    };
}

function createValidateTsInSrcTarget(): TargetConfiguration {
    return {
        executor: '@webpieces/nx-webpieces-rules:validate-ts-in-src',
        cache: false,
        inputs: ['default', '{workspaceRoot}/webpieces.config.json', {'runtime': 'node -e "process.stdout.write(String(Math.random()))"'}],
        metadata: {
            technologies: ['nx'],
            description: 'Validate all .ts files in projects are inside the src/ directory',
        },
    };
}

function createValidateNxWiringTarget(): TargetConfiguration {
    return {
        executor: '@webpieces/nx-webpieces-rules:validate-nx-wiring',
        cache: false, // Cheap; depends on nx.json + project graph, not worth caching
        inputs: ['{workspaceRoot}/nx.json'],
        metadata: {
            technologies: ['nx'],
            description: 'Validate the webpieces validators are wired into the build via nx.json dependsOn',
        },
    };
}

function createValidateCompleteTarget(validationTargets: string[]): TargetConfiguration {
    return {
        executor: 'nx:noop',
        cache: true,
        dependsOn: validationTargets,
        metadata: {
            technologies: ['nx'],
            description: 'Run all architecture validations (cycles, unchanged, skip-level deps)',
        },
    };
}

/**
 * Create per-project ci target - Gradle-style composite target
 * Runs lint, build, and test in parallel
 * (with test depending on build via targetDefaults)
 *
 * NOTE: Type checking is done by the build target (@nx/js:tsc) during compilation.
 */
function createCiTarget(): TargetConfiguration {
    return {
        executor: 'nx:noop',
        cache: true,
        dependsOn: ['lint', 'build', 'test'],
        metadata: {
            technologies: ['nx'],
            description: 'Run all CI checks: lint, build, and test (Gradle-style composite target)',
        },
    };
}

function createHelpTarget(): TargetConfiguration {
    return {
        executor: '@webpieces/nx-webpieces-rules:help',
        cache: false, // Never cache - always show help output
        metadata: {
            technologies: ['nx'],
            description: 'Display help for @webpieces/nx-webpieces-rules commands and targets',
        },
    };
}

/**
 * Create per-project circular dependency checking target.
 *
 * Uses the `validate-no-file-import-cycles` executor (which bundles madge as a
 * dependency) rather than a runtime `npx madge` fetch. The executor reads
 * webpieces.config.json so the gate can be turned on/off (`mode`) and
 * time-boxed (`ignoreModifiedUntilEpoch`) like every other webpieces rule.
 *
 * Note `projectRoot` is intentionally unused now — the executor derives the
 * project root from the Nx context — but the param is kept for call-site
 * symmetry with the rest of the per-project target factories.
 */
function createCircularDepsTarget(_projectRoot: string, _targetName: string): TargetConfiguration {
    return {
        executor: '@webpieces/nx-webpieces-rules:validate-no-file-import-cycles',
        cache: true,
        inputs: ['default'],
        outputs: [] as string[],
        metadata: {
            technologies: ['madge'],
            description: 'Check for circular file-import dependencies using madge',
        },
    };
}

/**
 * Check if a project should be excluded based on patterns
 */
function isExcluded(projectRoot: string, excludePatterns: string[]): boolean {
    if (excludePatterns.length === 0) {
        return false;
    }

    // Simple glob matching (could be enhanced with minimatch if needed)
    return excludePatterns.some((pattern) => {
        // Convert glob pattern to regex
        const regexPattern = pattern
            .replace(/\*\*/g, '.*') // ** matches any path
            .replace(/\*/g, '[^/]*'); // * matches any string except /

        const regex = new RegExp(`^${regexPattern}$`);
        return regex.test(projectRoot);
    });
}

/**
 * Export plugin as default for Nx
 */
export default { createNodesV2 };
