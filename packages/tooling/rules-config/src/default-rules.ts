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
    'runtime-architecture': { mode: 'RUN_EVERY_TIME' },
    'prisma-validate-dtos': {},
    'prisma-converter': {},
    'angular-no-direct-api-in-resolver': {},
    'no-symbol-di-tokens': {},
    // Ships OFF: a repo opts in per webpieces.config.json once it is ready to migrate any
    // client-in-a-lib sites (severity defaults to "warn" so even when enabled it reports without
    // failing until a repo flips it to "error").
    'no-client-creation-outside-server-or-client': { mode: 'OFF' },
    'no-custom-css': { allowGlobs: [] },
    // Ships ARMED, and diff-scoped. A template that restates a `.webpieces/` path ships that path into
    // every governed repo as instruction, and the paths are per-worktree — so the default has to be the
    // one that stops the NEXT one, not one a repo has to discover. NEW_AND_MODIFIED_CODE is what makes
    // that safe: the docs whose subject IS the layout are untouched until somebody edits the line.
    'no-state-paths-in-templates': { mode: 'NEW_AND_MODIFIED_CODE' },
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
    // human, and logs each deletion to the branch-mutation log (BranchMutationLog.branchMutationLogPath,
    // which is per-worktree) with the pre-delete SHA
    // and a ready-made `recover=` command. So the worst case is one paste to undo, which a human can
    // resolve; the previous default's worst case was unbounded accumulation nobody ever cleaned.
    //
    // Set it false to keep reaping manual; `pnpm wp-cleanup` works either way.
    'branch-creation-guard': {
        mode: 'ON',
        subBranchNaming: 'feature/<ticket>/<short-description>',
        autoReapMergedBranches: true,
    },
    'pr-lifecycle-guard': { mode: 'ON' },
    // NOTE: `whole-repo-build-guard` is deliberately ABSENT from this table, and from RULE_SCHEMAS and
    // HOOK_GUARD_NAMES with it. It is EXPERIMENTAL and OFF by default; the ONLY thing that turns it on
    // is `experimental.whole-repo-build-guard: true` in the optional machine-local
    // ~/.webpieces/config.json. Adding it back here would make it a rule every consumer must CONFIGURE
    // — which is fault Y, i.e. every Bash call blocked on upgrade, which is exactly what it did the
    // first time. See RETIRED_CONFIG_KEYS.
    //
    // branch-state-guard ships ON, INCLUDING its Read-blocking half.
    //
    // Its predecessor `read-stale-guard` shipped OFF as a "phase 1" staged rollout, on the reasoning
    // that Read is the highest-blast-radius tool there is and nobody should be armed before verifying
    // the fail-open paths against their own git layout. Phase 1 is over: this repo has run it ON in
    // production for releases, and the fail-open paths (branch undeterminable, cache absent, cache for
    // another branch, offline, dirty tree on main) are each covered by tests. Keeping it OFF now buys
    // nothing and costs the exact incident the guard exists for — a session spent reading a tree 18
    // commits behind while the log read "handled".
    //
    // Nothing is armed behind anyone's back either way: every built-in requires an explicit entry (the
    // config-sync check blocks until one exists), so a consumer states this mode themselves on upgrade.
    'branch-state-guard': { mode: 'ON' },
};

export const defaultRulesDir: readonly string[] = [];
