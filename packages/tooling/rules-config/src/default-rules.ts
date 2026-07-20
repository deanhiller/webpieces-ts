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
    'runtime-architecture': { mode: 'RUN_EVERY_TIME', servicePaths: [], apiProjectPaths: [], allowedCycles: [] },
    'prisma-validate-dtos': {},
    'prisma-converter': {},
    'angular-no-direct-api-in-resolver': {},
    'no-symbol-di-tokens': {},
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
    'branch-creation-guard': { mode: 'ON', subBranchNaming: 'feature/<ticket>/<short-description>' },
    'pr-creation-or-push-guard': { mode: 'ON' },
    'merge-in-progress-guard': { mode: 'ON' },
    'pr-merge-guard': { mode: 'ON' },
    'redirect-how-to-merge-main': { mode: 'ON' },
    // Phase 1 ships OFF on purpose. This guard blocks Read, the highest-blast-radius tool there is,
    // so it is opted into per-repo (webpieces.config.json → hookGuards) only AFTER the release
    // carrying it is published and installed. Flipping it ON here would arm it for every consumer
    // on upgrade, before anyone has verified the fail-open paths against their own git layout.
    'main-stale-guard': { mode: 'OFF' },
};

export const defaultRulesDir: readonly string[] = [];
