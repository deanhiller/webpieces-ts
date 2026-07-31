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
        outputs: ['{projectRoot}/design.json', '{projectRoot}/design.md', '{projectRoot}/design.html'],
        metadata: {
            technologies: ['nx'],
            description:
                'Generate the Inversify DI dependency DAG into design.json + design.md + clickable design.html',
        },
    };
}

// There is deliberately NO `createValidateDiGraphUnchangedTarget()` any more. That gate asked
// "is the working tree dirty here?" as a proxy for "is the committed design stale?" — two different
// questions — and it dirtied the tree as a side effect of validating. nx hashes tasks by input file
// CONTENTS, so one hash produced both a pass and a fail and nx labelled the task "flaky"; it was not
// flaky, it was stateful in a dimension nx cannot see. It also could not pass mid-3-point-merge, where
// merge-in-progress-guard blocks the `git commit` it demanded.
//
// The invariant now lives in ONE repo-wide check in `wp-review-upsert-pr` (@webpieces/pr-gate
// BuildArtifactGate), which runs right after buildCommand and requires every path the build touched to
// be committed OR STAGED. That covers the whole repo instead of one project's design.*, and "staged
// counts" is what makes it hold mid-merge with no special case. `di-graph-generate` STAYS — the design
// files are still generated and still committed; only the git-state-dependent gate is gone.
