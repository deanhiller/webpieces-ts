// Default holistic exclude list for the validate-ts-in-src
// rules. Bare names match a directory segment at any depth; globs match the
// workspace-relative path. `**/*.d.ts` (ambient declarations) and
// `**/jest.config.ts` legitimately live outside src/ and are exempt here.
const DEFAULT_EXCLUDE_PATHS: readonly string[] = [
    'node_modules',
    'dist',
    '.nx',
    '.git',
    '**/*.d.ts',
    '**/jest.config.ts',
];

// A RULE HAS NO DEFAULT. Not `mode`, and not any other field a schema marks REQUIRED.
//
// This table is TUNING ONLY: the value an OPTIONAL field takes when a consumer omits it, and the value
// the installer seeds that field with. It may never carry `mode`, and it may never carry a
// schema-required field — `no-rule-defaults.spec.ts` fails the build if one appears, and
// `webpieces-config-defaults-reviewer` fails the PR.
//
// Why, in one paragraph. Every rule with a schema is one `webpieces.config.json` must carry an entry
// for: validateWebpiecesConfig pushes a copy-paste snippet for every RULE_SCHEMAS key the config does
// not name, and that error FAILS THE LOAD. A default sitting beneath that is therefore not "the value
// when nobody said" — it is the value when the loader is bypassed, and its real effect is to make the
// question look answered. The consumer ANSWERING it is the product: a repo that was never asked
// whether merged branches may be deleted unattended is a repo where nobody decided, and an agent
// authoring a rule is the wrong party to decide that on every downstream repo's behalf. The failing
// load is the delivery mechanism, exactly as a compile error is for a changed surface — the upgrade
// breaks, the agent reads "add this entry", finds out what it means, and the human chooses.
//
// The six entries #1017 measured are gone from here, and every consumer must now state each one in
// its own config: branch-creation-guard (mode + subBranchNaming + autoReapMergedBranches),
// pr-lifecycle-guard (mode), branch-state-guard (mode + maxCommitsBehind), no-root-union-api-type,
// api-rules-for-openapi and api-rules-for-mcp (mode). THIS repo states only the first three today —
// the other three are new keys the one-release-behind validator does not know yet
// (.claude/rules/published-vs-local-source.md), so they land with the pin bump, tracked in #1015.
// `autoReapMergedBranches` and `subBranchNaming` are schema-REQUIRED
// because they are BEHAVIOUR — one deletes branches unattended, the other decides which branch names
// are blocked — and behaviour is stated, never inherited. The numeric caps (maxLocalBranches,
// maxWorktrees) stay optional knobs on purpose: they tune a refusal that PRINTS the cap it hit, so the
// value is visible at the moment it bites rather than only in webpieces' source.
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
    'no-file-import-cycles': {},
    'runtime-architecture': {},
    'prisma-validate-dtos': {},
    'prisma-converter': {},
    'angular-no-direct-api-in-resolver': {},
    'no-symbol-di-tokens': {},
    'no-client-creation-outside-server-or-client': {},
    'no-custom-css': { allowGlobs: [] },
    'no-state-paths-in-templates': {},
    'no-process-exit-outside-main': {},
    'inject-annotation-not-needed-for-concrete-class': {},
    'framework-tag': {
        knownTypes: ['browser', 'react', 'angular', 'node', 'express'],
    },
    'role-tag': {
        knownTypes: ['server', 'app', 'designed-lib', 'lib', 'client', 'api-lib'],
    },
    'ensure-we-are-secure': {},
    'nx-wiring': {},
    'di-graph': {},
    'missing-design-annotation': {},
    'validate-ts-in-src': {
        allowedRootFiles: ['jest.setup.ts'],
        excludePaths: [...DEFAULT_EXCLUDE_PATHS],
    },
    'no-js-files': {},
    'validate-architecture-unchanged': {},
    'validate-no-architecture-cycles': {},
    'validate-packagejson': {},
    'validate-versions-locked': {},
    'validate-eslint-sync': {},
    'no-root-union-api-type': {},
    'api-rules-for-openapi': {},
    'api-rules-for-mcp': {},
    // #1023: both REQUIRE `mode` — no entry here may carry one. Like the three above they are new keys
    // the one-release-behind validator does not know yet, so THIS repo's config states them with the
    // pin bump to the release that ships them, tracked in #1024.
    'no-inline-import-in-api-lib': {},
    'one-enum-spelling-in-api-lib': {},
    'branch-creation-guard': {},
    'pr-lifecycle-guard': {},
    // NOTE: `whole-repo-build-guard` is deliberately ABSENT from this table, and from RULE_SCHEMAS and
    // HOOK_GUARD_NAMES with it. It is EXPERIMENTAL and OFF by default; the ONLY thing that turns it on
    // is `experimental.whole-repo-build-guard: true` in the optional machine-local
    // ~/.webpieces/config.json. Adding it back here would make it a rule every consumer must CONFIGURE
    // — which is fault Y, i.e. every Bash call blocked on upgrade, which is exactly what it did the
    // first time. See RETIRED_CONFIG_KEYS.
    'branch-state-guard': {},
};

export const defaultRulesDir: readonly string[] = [];
