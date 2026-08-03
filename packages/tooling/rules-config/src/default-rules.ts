// Default holistic exclude list for the validate-ts-in-src
// rules. Bare names match a directory segment at any depth; globs match the
// workspace-relative path. `**/*.d.ts` (ambient declarations) and
// `**/jest.config.ts` legitimately live outside src/ and are exempt here.
const DEFAULT_EXCLUDE_PATHS: readonly string[] = [
    'node_modules', 'dist', '.nx', '.git',
    '**/*.d.ts', '**/jest.config.ts',
];

// On/off is driven by `mode` ("OFF" disables; an absent mode leaves a rule
// on). Code-rules entries omit `mode` so each executor keeps its own default
// scope; structural rules declare `mode: 'RUN_EVERY_TIME'`, bash guards `mode: 'ON'`.
// webpieces-disable no-any-unknown -- rule options are opaque at framework level
export const defaultRules: Record<string, Record<string, unknown>> = {
    'no-any-unknown': {},
    'no-implicit-any': {},
    'max-file-lines': { limit: 900 },
    'max-method-lines': { limit: 80 },
    'require-return-type': {},
    'no-inline-type-literals': {},
    'no-destructure': { allowTopLevel: true },
    'catch-error-pattern': {},
    'no-unmanaged-exceptions': {},
    'no-file-import-cycles': { mode: 'RUN_EVERY_TIME' },
    'runtime-architecture': { mode: 'RUN_EVERY_TIME', allowedCycles: [] },
    'prisma-validate-dtos': {},
    'prisma-converter': {},
    'angular-no-direct-api-in-resolver': {},
    'no-symbol-di-tokens': {},
    // Ships OFF: a repo opts in per webpieces.config.json once it is ready to migrate any
    // client-in-a-lib sites (severity defaults to "warn" so even when enabled it reports without
    // failing until a repo flips it to "error").
    'no-client-creation-outside-server-or-client': { mode: 'OFF' },
    'no-custom-css': { allowGlobs: [] },
    'no-process-exit-outside-main': {},
    'inject-annotation-not-needed-for-concrete-class': {},
    'framework-tag': { mode: 'MODIFIED_PROJECTS', knownTypes: ['browser', 'react', 'angular', 'node', 'express'] },
    'role-tag': { mode: 'MODIFIED_PROJECTS', knownTypes: ['server', 'app', 'designed-lib', 'lib', 'client', 'api-lib'] },
    'nx-wiring': { mode: 'RUN_EVERY_TIME' },
    'di-graph': { mode: 'RUN_EVERY_TIME' },
    'missing-design-annotation': { mode: 'RUN_EVERY_TIME' },
    'validate-ts-in-src': {
        mode: 'NEW_AND_MODIFIED_FILES',
        allowedRootFiles: ['jest.setup.ts'],
        excludePaths: [...DEFAULT_EXCLUDE_PATHS],
    },
    'no-js-files': { mode: 'OFF' },
    // The five Nx infrastructure validators. They enforced unconditionally before they were wired to
    // config, so RUN_EVERY_TIME is the only default that keeps existing repos behaving identically on
    // upgrade. Set "mode": "OFF" to disable one; the two graph-baseline rules
    // (validate-architecture-unchanged / validate-no-architecture-cycles) additionally honor
    // turnOffRuleUntilEpoch — the other three are all-or-nothing (see rule-configs.ts).
    'validate-architecture-unchanged': { mode: 'RUN_EVERY_TIME' },
    'validate-no-architecture-cycles': { mode: 'RUN_EVERY_TIME' },
    'validate-packagejson': { mode: 'RUN_EVERY_TIME' },
    'validate-versions-locked': { mode: 'RUN_EVERY_TIME' },
    'validate-eslint-sync': { mode: 'RUN_EVERY_TIME' },
    // autoReapMergedBranches ships TRUE, and it is also what a fresh config is seeded with.
    //
    // It shipped FALSE on the reasoning that an upgrade must never delete branches unattended before a
    // human opts in. In practice that produced the opposite of safety: nobody opts in, dead branches
    // pile up, and the pile is what makes a real branch hard to find. The reap is also NOT destructive
    // in the way the old comment implied — BranchReaper deletes only provably-dead branches (a merged
    // PR, a squash-merge backup of one, or no commits of their own), spares everything else for a
    // human, and logs each deletion to .webpieces/hooks/branch-mutations.log with the pre-delete SHA
    // and a ready-made `recover=` command. So the worst case is one paste to undo, which a human can
    // resolve; the previous default's worst case was unbounded accumulation nobody ever cleaned.
    //
    // Set it false to keep reaping manual; `pnpm wp-cleanup` works either way.
    'branch-creation-guard': {
        mode: 'ON',
        subBranchNaming: 'feature/<ticket>/<short-description>',
        autoReapMergedBranches: true,
    },
    'pr-creation-or-push-guard': { mode: 'ON' },
    'merge-in-progress-guard': { mode: 'ON' },
    'pr-merge-guard': { mode: 'ON' },
    'redirect-how-to-merge-main': { mode: 'ON' },
    // Phase 1 ships OFF on purpose. This guard blocks Read, the highest-blast-radius tool there is,
    // so it is opted into per-repo (webpieces.config.json → hookGuards) only AFTER the release
    // carrying it is published and installed. Flipping it ON here would arm it for every consumer
    // on upgrade, before anyone has verified the fail-open paths against their own git layout.
    'read-stale-guard': { mode: 'OFF' },
};

export const defaultRulesDir: readonly string[] = [];
