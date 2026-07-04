/**
 * Per-project DI design graph targets (design.json + design.md), attached to every
 * project.json project by the inference plugin. Split out of plugin.ts the same way
 * as runtime-targets.ts.
 */

import type { TargetConfiguration } from '@nx/devkit';

/**
 * Create per-project DI graph generation target. cache:false because the point
 * is to regenerate design.json/design.md on EVERY build so the committed DI
 * design DAG can never silently drift from the code.
 */
export function createDiGraphGenerateTarget(): TargetConfiguration {
    return {
        executor: '@webpieces/nx-webpieces-rules:di-graph-generate',
        cache: false,
        outputs: ['{projectRoot}/design.json', '{projectRoot}/design.md'],
        metadata: {
            technologies: ['nx'],
            description: 'Generate the Inversify DI dependency DAG into design.json + design.md',
        },
    };
}

/**
 * Create per-project DI graph staleness gate — regenerates first (dependsOn),
 * then fails if the regenerated files differ from the committed copies.
 */
export function createValidateDiGraphUnchangedTarget(): TargetConfiguration {
    return {
        executor: '@webpieces/nx-webpieces-rules:validate-di-graph-unchanged',
        cache: false, // Depends on git state
        dependsOn: ['di-graph-generate'],
        metadata: {
            technologies: ['nx'],
            description: 'Validate the committed design.json/design.md match the regenerated DI graph',
        },
    };
}
