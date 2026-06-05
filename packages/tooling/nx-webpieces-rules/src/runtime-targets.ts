/**
 * Runtime-graph target factories for the inference plugin (kept out of plugin.ts
 * to keep that file under the file-size limit).
 */

import type { TargetConfiguration } from '@nx/devkit';

/** `microsvc:visualize` — render the runtime microservice graph. */
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
            '{workspaceRoot}/**/live.json',
            '{workspaceRoot}/architecture/runtime-dependencies.json',
            '{workspaceRoot}/webpieces.config.json',
        ],
        metadata: {
            technologies: ['nx'],
            description: 'Validate the runtime microservice graph (no disallowed cycles, unchanged)',
        },
    };
}

/** Per-project: validate this project's live.json matches its api-project deps. */
export function createValidateRuntimeMarkersTarget(): TargetConfiguration {
    return {
        executor: '@webpieces/nx-webpieces-rules:validate-runtime-markers',
        cache: true,
        inputs: ['default', '{workspaceRoot}/**/live.json', '{workspaceRoot}/webpieces.config.json'],
        metadata: {
            technologies: ['nx'],
            description: "Validate this project's live.json matches its api-project dependencies",
        },
    };
}
