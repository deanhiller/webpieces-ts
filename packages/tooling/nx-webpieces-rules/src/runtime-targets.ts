/**
 * Runtime-graph target factories for the inference plugin (kept out of plugin.ts
 * to keep that file under the file-size limit).
 */

import type { TargetConfiguration } from '@nx/devkit';

/** `architecture:visualize-runtime` — render the runtime microservice graph. */
export function createVisualizeRuntimeTarget(): TargetConfiguration {
    return {
        executor: '@webpieces/nx-webpieces-rules:visualize-runtime',
        dependsOn: ['architecture:generate'],
        metadata: {
            technologies: ['nx'],
            description: 'Render the runtime microservice graph (runtime-dependencies.json)',
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
            '{workspaceRoot}/architecture/runtime-dependencies.json',
            '{workspaceRoot}/webpieces.config.json',
        ],
        metadata: {
            technologies: ['nx'],
            description: 'Validate the runtime microservice graph (no disallowed cycles, unchanged)',
        },
    };
}
