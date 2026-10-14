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

/**
 * `architecture:visualize-runtime-goal` (#1239) — render the hand-authored runtime goal. Inferred with
 * visualize-runtime, so every repo with the runtime viewer gets it without hand-wiring a target. No
 * dependsOn: it reads saved files only and never generates first.
 */
// webpieces-disable no-function-outside-class -- inferred-target factory, matching its siblings in this file
export function createVisualizeRuntimeGoalTarget(): TargetConfiguration {
    return {
        executor: '@webpieces/nx-webpieces-rules:visualize-runtime-goal',
        cache: false,
        metadata: {
            technologies: ['nx'],
            description:
                'View the runtime goal (architecture/runtime-dependencies-goal.json) with Goal vs Current; never generates. --prepare recomputes its levels',
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
