/**
 * Unified Nx Inference Plugin for @webpieces/dev-config
 *
 * This plugin automatically creates targets for:
 * 1. Workspace-level architecture validation (generate, visualize, validate-*)
 * 2. Per-project circular dependency checking
 *
 * Install with: nx add @webpieces/dev-config
 *
 * Usage:
 * Add to nx.json plugins array:
 * {
 *   "plugins": ["@webpieces/dev-config"]
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

/**
 * Configuration for @webpieces/dev-config Nx plugin
 */
export interface ArchitecturePluginOptions {
    circularDeps?: {
        enabled?: boolean;
        targetName?: string;
        excludePatterns?: string[];
    };
    workspace?: {
        enabled?: boolean;
        targetPrefix?: string;
        graphPath?: string;
        validations?: {
            noCycles?: boolean;
            noSkipLevelDeps?: boolean;
            architectureUnchanged?: boolean;
        };
        features?: {
            generate?: boolean;
            visualize?: boolean;
        };
    };
}

const DEFAULT_OPTIONS: Required<ArchitecturePluginOptions> = {
    circularDeps: {
        enabled: true,
        targetName: 'check-circular-deps',
        excludePatterns: [],
    },
    workspace: {
        enabled: true,
        targetPrefix: 'arch:',
        graphPath: 'architecture/dependencies.json',
        validations: {
            noCycles: true,
            noSkipLevelDeps: true,
            architectureUnchanged: true,
        },
        features: {
            generate: true,
            visualize: true,
        },
    },
};

function normalizeOptions(
    options: ArchitecturePluginOptions | undefined
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
    context: CreateNodesContextV2
): Promise<CreateNodesResultV2> {
    const opts = normalizeOptions(options);
    const results: Array<readonly [string, CreateNodesResult]> = [];

    // Add workspace-level architecture targets
    addArchitectureProject(results, projectFiles, opts, context);

    // Add per-project circular-deps targets
    addCircularDepsTargets(results, projectFiles, opts, context);

    return results;
}

function addArchitectureProject(
    results: Array<readonly [string, CreateNodesResult]>,
    projectFiles: readonly string[],
    opts: Required<ArchitecturePluginOptions>,
    context: CreateNodesContextV2
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

function addCircularDepsTargets(
    results: Array<readonly [string, CreateNodesResult]>,
    projectFiles: readonly string[],
    opts: Required<ArchitecturePluginOptions>,
    context: CreateNodesContextV2
): void {
    if (!opts.circularDeps.enabled) return;

    for (const projectFile of projectFiles) {
        if (!projectFile.endsWith('project.json')) continue;

        const projectRoot = dirname(projectFile);
        if (projectRoot === '.') continue;

        if (isExcluded(projectRoot, opts.circularDeps.excludePatterns!)) continue;

        const srcDir = join(context.workspaceRoot, projectRoot, 'src');
        if (!existsSync(srcDir)) continue;

        const targetName = opts.circularDeps.targetName!;
        const checkCircularDepsTarget = createCircularDepsTarget(projectRoot, targetName);

        const result: CreateNodesResult = {
            projects: {
                [projectRoot]: {
                    targets: {
                        [targetName]: checkCircularDepsTarget,
                    },
                },
            },
        };

        results.push([projectFile, result] as const);
    }
}

/**
 * Nx V2 Inference Plugin
 * Matches project.json files to create targets
 */
export const createNodesV2: CreateNodesV2<ArchitecturePluginOptions> = [
    // Pattern to match project.json files
    '**/project.json',

    // Inference function
    createNodesFunction,
];

/**
 * Create workspace-level architecture validation targets WITHOUT prefix
 * Used for virtual 'architecture' project
 */
function createWorkspaceTargetsWithoutPrefix(opts: Required<ArchitecturePluginOptions>): Record<string, TargetConfiguration> {
    const targets: Record<string, TargetConfiguration> = {};
    const graphPath = opts.workspace.graphPath!;

    // Add help target (always available)
    targets['help'] = createHelpTarget();

    if (opts.workspace.features!.generate) {
        targets['generate'] = createGenerateTarget(graphPath);
    }

    if (opts.workspace.features!.visualize) {
        targets['visualize'] = createVisualizeTargetWithoutPrefix(graphPath);
    }

    if (opts.workspace.validations!.noCycles) {
        targets['validate-no-cycles'] = createValidateNoCyclesTarget();
    }

    if (opts.workspace.validations!.architectureUnchanged) {
        targets['validate-architecture-unchanged'] = createValidateUnchangedTarget(graphPath);
    }

    if (opts.workspace.validations!.noSkipLevelDeps) {
        targets['validate-no-skiplevel-deps'] = createValidateNoSkipLevelTarget();
    }

    // Add validate-complete target that runs all validations
    const validationTargets: string[] = [];
    if (opts.workspace.validations!.noCycles) {
        validationTargets.push('validate-no-cycles');
    }
    if (opts.workspace.validations!.architectureUnchanged) {
        validationTargets.push('validate-architecture-unchanged');
    }
    if (opts.workspace.validations!.noSkipLevelDeps) {
        validationTargets.push('validate-no-skiplevel-deps');
    }

    if (validationTargets.length > 0) {
        targets['validate-complete'] = createValidateCompleteTarget(validationTargets);
    }

    return targets;
}

/**
 * Create workspace-level architecture validation targets (DEPRECATED - keeping for backward compat)
 * Used when root project.json exists (old style with '.' project)
 */
function createWorkspaceTargets(opts: Required<ArchitecturePluginOptions>): Record<string, TargetConfiguration> {
    const targets: Record<string, TargetConfiguration> = {};
    const prefix = opts.workspace.targetPrefix!;
    const graphPath = opts.workspace.graphPath!;

    // Add help target (always available)
    targets[`${prefix}help`] = createHelpTarget();

    if (opts.workspace.features!.generate) {
        targets[`${prefix}generate`] = createGenerateTarget(graphPath);
    }

    if (opts.workspace.features!.visualize) {
        targets[`${prefix}visualize`] = createVisualizeTarget(prefix, graphPath);
    }

    if (opts.workspace.validations!.noCycles) {
        targets[`${prefix}validate-no-cycles`] = createValidateNoCyclesTarget();
    }

    if (opts.workspace.validations!.architectureUnchanged) {
        targets[`${prefix}validate-architecture-unchanged`] = createValidateUnchangedTarget(graphPath);
    }

    if (opts.workspace.validations!.noSkipLevelDeps) {
        targets[`${prefix}validate-no-skiplevel-deps`] = createValidateNoSkipLevelTarget();
    }

    return targets;
}

function createGenerateTarget(graphPath: string): TargetConfiguration {
    return {
        executor: '@webpieces/dev-config:generate',
        cache: true,
        inputs: ['default'],
        outputs: ['{workspaceRoot}/architecture/dependencies.json'],
        options: { graphPath },
        metadata: {
            technologies: ['nx'],
            description: 'Generate the architecture dependency graph from project.json files',
        },
    };
}

function createVisualizeTargetWithoutPrefix(graphPath: string): TargetConfiguration {
    return {
        executor: '@webpieces/dev-config:visualize',
        dependsOn: ['generate'],
        options: { graphPath },
        metadata: {
            technologies: ['nx'],
            description: 'Generate visual representations of the architecture graph',
        },
    };
}

function createVisualizeTarget(prefix: string, graphPath: string): TargetConfiguration {
    return {
        executor: '@webpieces/dev-config:visualize',
        dependsOn: [`${prefix}generate`],
        options: { graphPath },
        metadata: {
            technologies: ['nx'],
            description: 'Generate visual representations of the architecture graph',
        },
    };
}

function createValidateNoCyclesTarget(): TargetConfiguration {
    return {
        executor: '@webpieces/dev-config:validate-no-cycles',
        cache: true,
        inputs: ['default'],
        metadata: {
            technologies: ['nx'],
            description: 'Validate the architecture has no circular dependencies',
        },
    };
}

function createValidateUnchangedTarget(graphPath: string): TargetConfiguration {
    return {
        executor: '@webpieces/dev-config:validate-architecture-unchanged',
        cache: true,
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
        executor: '@webpieces/dev-config:validate-no-skiplevel-deps',
        cache: true,
        inputs: ['default'],
        metadata: {
            technologies: ['nx'],
            description: 'Validate no project has redundant transitive dependencies',
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

function createHelpTarget(): TargetConfiguration {
    return {
        executor: '@webpieces/dev-config:help',
        cache: true,
        metadata: {
            technologies: ['nx'],
            description: 'Display help for @webpieces/dev-config commands and targets',
        },
    };
}

/**
 * Create per-project circular dependency checking target
 */
function createCircularDepsTarget(projectRoot: string, targetName: string): TargetConfiguration {
    return {
        executor: 'nx:run-commands',
        cache: true,
        inputs: ['default'],
        outputs: [] as string[],
        options: {
            command: 'npx madge --circular --extensions ts,tsx src',
            cwd: projectRoot,
        },
        metadata: {
            technologies: ['madge'],
            description: 'Check for circular dependencies using madge',
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
