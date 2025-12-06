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
    };
}

/**
 * Nx V2 Inference Plugin
 * Matches project.json files and creates architecture + circular-deps targets
 */
export const createNodesV2: CreateNodesV2<ArchitecturePluginOptions> = [
    // Pattern to match: look for project.json files
    '**/project.json',

    // Inference function
    async (
        projectFiles: readonly string[],
        options: ArchitecturePluginOptions | undefined,
        context: CreateNodesContextV2
    ): Promise<CreateNodesResultV2> => {
        const opts = normalizeOptions(options);
        const results: Array<readonly [string, CreateNodesResult]> = [];

        // Phase 1: Add workspace-level architecture targets to root
        if (opts.workspace.enabled) {
            const rootProject = projectFiles.find((f) => dirname(f) === '.');

            if (rootProject) {
                const workspaceTargets = createWorkspaceTargets(opts);

                if (Object.keys(workspaceTargets).length > 0) {
                    const result: CreateNodesResult = {
                        projects: {
                            '.': {
                                targets: workspaceTargets,
                            },
                        },
                    };

                    results.push([rootProject, result] as const);
                }
            }
        }

        // Phase 2: Add per-project circular-deps targets
        if (opts.circularDeps.enabled) {
            for (const projectFile of projectFiles) {
                const projectRoot = dirname(projectFile);

                // Skip workspace root (already handled)
                if (projectRoot === '.') continue;

                // Check exclude patterns
                if (isExcluded(projectRoot, opts.circularDeps.excludePatterns)) {
                    continue;
                }

                // Only create target if project has a src/ directory
                const srcDir = join(context.workspaceRoot, projectRoot, 'src');
                if (existsSync(srcDir)) {
                    const checkCircularDepsTarget = createCircularDepsTarget(
                        projectRoot,
                        opts.circularDeps.targetName
                    );

                    const result: CreateNodesResult = {
                        projects: {
                            [projectRoot]: {
                                targets: {
                                    [opts.circularDeps.targetName]: checkCircularDepsTarget,
                                },
                            },
                        },
                    };

                    results.push([projectFile, result] as const);
                }
            }
        }

        return results;
    },
];

/**
 * Create workspace-level architecture validation targets
 */
function createWorkspaceTargets(opts: Required<ArchitecturePluginOptions>): Record<string, TargetConfiguration> {
    const targets: Record<string, TargetConfiguration> = {};
    const prefix = opts.workspace.targetPrefix;

    if (opts.workspace.features.generate) {
        targets[`${prefix}generate`] = createGenerateTarget(opts.workspace.graphPath);
    }

    if (opts.workspace.features.visualize) {
        targets[`${prefix}visualize`] = createVisualizeTarget(prefix, opts.workspace.graphPath);
    }

    if (opts.workspace.validations.noCycles) {
        targets[`${prefix}validate-no-cycles`] = createValidateNoCyclesTarget();
    }

    if (opts.workspace.validations.architectureUnchanged) {
        targets[`${prefix}validate-architecture-unchanged`] = createValidateUnchangedTarget(opts.workspace.graphPath);
    }

    if (opts.workspace.validations.noSkipLevelDeps) {
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
