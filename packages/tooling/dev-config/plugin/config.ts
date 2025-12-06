/**
 * Configuration for @webpieces/dev-config Nx plugin
 */

export interface ArchitecturePluginOptions {
    /**
     * Per-project circular dependency checking
     */
    circularDeps?: {
        /**
         * Enable circular dependency checking for projects
         * @default true
         */
        enabled?: boolean;

        /**
         * Name of the target to create for circular dependency checking
         * @default 'check-circular-deps'
         */
        targetName?: string;

        /**
         * Patterns to exclude from circular dependency checking
         * @default []
         * @example ['**/test-fixtures/**', '**/__tests__/**']
         */
        excludePatterns?: string[];
    };

    /**
     * Workspace-level architecture validation
     */
    workspace?: {
        /**
         * Enable workspace-level architecture validation
         * @default true
         */
        enabled?: boolean;

        /**
         * Prefix for workspace-level target names
         * @default 'arch:'
         * @example 'arch:' creates targets like 'arch:generate', 'arch:validate-no-cycles'
         */
        targetPrefix?: string;

        /**
         * Path to the architecture dependencies graph file
         * @default 'architecture/dependencies.json'
         */
        graphPath?: string;

        /**
         * Individual validations that can be enabled/disabled
         */
        validations?: {
            /**
             * Validate the architecture has no circular dependencies
             * @default true
             */
            noCycles?: boolean;

            /**
             * Validate no project has redundant transitive dependencies
             * @default true
             */
            noSkipLevelDeps?: boolean;

            /**
             * Validate the architecture matches the saved blessed graph
             * @default true
             */
            architectureUnchanged?: boolean;
        };

        /**
         * Additional features
         */
        features?: {
            /**
             * Enable graph generation target
             * @default true
             */
            generate?: boolean;

            /**
             * Enable graph visualization target
             * @default true
             */
            visualize?: boolean;
        };
    };
}

/**
 * Default configuration options
 */
export const DEFAULT_OPTIONS: Required<ArchitecturePluginOptions> = {
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

/**
 * Merge user options with defaults
 */
export function normalizeOptions(
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
