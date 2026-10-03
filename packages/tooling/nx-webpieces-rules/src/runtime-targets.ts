/**
 * Runtime-graph target factories for the inference plugin (kept out of plugin.ts
 * to keep that file under the file-size limit).
 */

import type { TargetConfiguration } from '@nx/devkit';

/** `architecture:visualize-runtime` — render the runtime microservice graph. */
export function createVisualizeRuntimeTarget(): TargetConfiguration {
    return {
        executor: '@webpieces/nx-webpieces-rules:visualize-runtime',
        cache: false,
        metadata: {
            technologies: ['nx'],
            description: 'View saved runtime architecture without refreshing; refresh: pnpm nx run architecture:generate',
        },
    };
}

/** Workspace: validate no disallowed runtime cycles + graph unchanged. */
export function createValidateRuntimeArchitectureTarget(): TargetConfiguration {
    return {
        executor: '@webpieces/nx-webpieces-rules:validate-runtime-architecture',
        cache: false,
        inputs: [
            'default',
            '{workspaceRoot}/architecture/dependencies.json',
            '{workspaceRoot}/architecture/apis/**/*',
            '{workspaceRoot}/architecture/runtime-dependencies.json',
            '{workspaceRoot}/webpieces.config.json',
        ],
        metadata: {
            technologies: ['nx'],
            description: 'Validate the runtime microservice graph (no disallowed cycles, unchanged)',
        },
    };
}
