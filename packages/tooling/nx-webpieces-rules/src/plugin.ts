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
} from './runtime-targets';
import { ValidationTargets } from './validation-targets';
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
    validateApiRelations?: boolean;
    validateApiLibTag?: boolean;
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
            validateApiRelations: true,
            validateApiLibTag: true,
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

    // Add per-project targets (circular-deps, ci, di-graph)
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

        const architectureEnabled =
            opts.workspace.enabled === true &&
            existsSync(join(context.workspaceRoot, 'architecture'));
        const targets = buildPerProjectTargets(
            isProjectJson,
            projectRoot,
            opts,
            architectureEnabled,
        );

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
    architectureEnabled: boolean,
): Record<string, TargetConfiguration> {
    const targets: Record<string, TargetConfiguration> = {};

    // Per-project validation gates that `ci` must depend on. Collected as they are added
    // so `ci` references only gates that actually exist on THIS project (a package.json-only
    // project has none).
    const validationTargets: string[] = [];

    // Add circular-deps target ONLY for project.json projects
    if (isProjectJson && opts.circularDeps.enabled) {
        if (!isExcluded(projectRoot, opts.circularDeps.excludePatterns!)) {
            const targetName = opts.circularDeps.targetName!;
            targets[targetName] = createCircularDepsTarget(projectRoot, targetName);
            validationTargets.push(targetName);
        }
    }

    // Per-project DI design DAG: regenerate design.json/design.md on every build,
    // then gate CI on the committed copies being current.
    if (isProjectJson && opts.workspace.validations!.diGraph) {
        targets['di-graph-generate'] = createDiGraphGenerateTarget();
        targets['validate-di-graph-unchanged'] = createValidateDiGraphUnchangedTarget();
        validationTargets.push('validate-di-graph-unchanged');
    }

    // Add ci target to ALL projects (both project.json and package.json). ci aggregates
    // lint + build + test + the validation gates that formerly rode on the compile
    // executor's targetDefaults, so a bare `build` stays a fast compile-only step.
    targets['ci'] = createCiTarget(validationTargets, architectureEnabled);

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
    if (validations!.validateApiRelations) targets.push('validate-api-relations');
    if (validations!.validateApiLibTag) targets.push('validate-api-lib-tag');
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
    // One ValidationTargets instance, injected below to build each target config.
    const targetFactory = new ValidationTargets();

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
        targets['validate-no-architecture-cycles'] = targetFactory.noCycles();
    }
    if (validations.architectureUnchanged) {
        targets['validate-architecture-unchanged'] = createValidateUnchangedTarget(graphPath);
    }
    if (validations.noSkipLevelDeps) {
        targets['validate-no-skiplevel-deps'] = targetFactory.noSkipLevel();
    }
    if (validations.validatePackageJson) {
        targets['validate-packagejson'] = targetFactory.packageJson();
    }
    // Use combined validate-code instead of 3 separate targets
    // Options come from webpieces.config.json at the workspace root
    // (loaded via @webpieces/rules-config; same source of truth as @webpieces/ai-hook-rules)
    if (
        validations.validateNewMethods ||
        validations.validateModifiedMethods ||
        validations.validateModifiedFiles
    ) {
        targets['validate-code'] = targetFactory.code();
    }
    if (validations.validateVersionsLocked) {
        targets['validate-versions-locked'] = targetFactory.versionsLocked();
    }
    if (validations.validateTsInSrc) {
        targets['validate-ts-in-src'] = targetFactory.tsInSrc();
    }
    if (validations.validateNxWiring) {
        targets['validate-nx-wiring'] = targetFactory.nxWiring();
    }
    if (validations.runtimeArchitecture) {
        targets['validate-runtime-architecture'] = createValidateRuntimeArchitectureTarget();
    }
    if (validations.validateApiRelations) {
        targets['validate-api-relations'] = targetFactory.apiRelations();
    }
    if (validations.validateApiLibTag) {
        targets['validate-api-lib-tag'] = targetFactory.apiLibTag();
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
 * Composite CI target: runs lint, build, test, and every validation gate.
 *
 * Validation (architecture graph completeness, per-project file-import cycles, DI-graph
 * unchanged) lives HERE, not on the build/compile target. That keeps `nx build` a fast
 * compile-only step for local iteration while `nx ci` is the full gate the PR check runs.
 *
 * The per-project gates are passed in because they exist only on project.json projects;
 * `architecture:validate-complete` is a cross-project dep added only when the workspace
 * `architecture` project exists.
 *
 * NOTE: Type checking is done by the build target (@nx/js:tsc) during compilation.
 */
// webpieces-disable no-function-outside-class -- Nx inference plugin: createNodes invokes these as module-scope target factories; the entire plugin is intentionally functional (matching the surrounding 18 factories), a DI class is not how the Nx plugin API is called.
export function createCiTarget(
    perProjectValidation: string[],
    architectureEnabled: boolean,
): TargetConfiguration {
    const dependsOn: string[] = ['lint', 'build', 'test', ...perProjectValidation];
    if (architectureEnabled) {
        dependsOn.push('architecture:validate-complete');
    }
    return {
        executor: 'nx:noop',
        cache: true,
        dependsOn,
        metadata: {
            technologies: ['nx'],
            description:
                'Run all CI checks: lint, build, test, and validation (Gradle-style composite target)',
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
