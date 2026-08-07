// The rule-name -> schema lookup table, split out of validate-config.ts (which hit the 700-line cap).
// Every consumer of "what fields does rule X have" reads it from here: the validator, the missing-rule
// snippet, and the installer's seeding (seed-entry.ts) — one table, so they cannot disagree.
import { FieldDef } from './field-def';
import {
    FeatureBranchGuardConfig,
    ReadStaleGuardConfig,
    MergedBranchBashGuardConfig,
    StaleMainBashGuardConfig,
} from './main-sync-guard-configs';
import {
    MaxMethodLinesConfig,
    MaxFileLinesConfig,
    RequireReturnTypeConfig,
    NoInlineTypeLiteralsConfig,
    NoAnyUnknownConfig,
    NoImplicitAnyConfig,
    PrismaValidateDtosConfig,
    PrismaConverterConfig,
    NoDestructureConfig,
    NoUnmanagedExceptionsConfig,
    CatchErrorPatternConfig,
    ThrowCauseRequiredConfig,
    AngularNoDirectApiInResolverConfig,
    NoSymbolDiTokensConfig,
    NoCustomCssConfig,
    NoProcessExitOutsideMainConfig,
    NoFunctionOutsideClassConfig,
    InjectAnnotationNotNeededForConcreteClassConfig,
    FrameworkTagConfig,
    RoleTagConfig,
    BranchCreationGuardConfig,
    PrCreationOrPushGuardConfig,
    MergeInProgressGuardConfig,
    PrMergeGuardConfig,
    RedirectHowToMergeMainConfig,
    WholeRepoBuildGuardConfig,
    NoFileImportCyclesConfig,
    RuntimeArchitectureConfig,
    NxWiringConfig,
    DiGraphConfig,
    MissingDesignAnnotationConfig,
    NoJsFilesConfig,
    ValidateTsInSrcConfig,
    ValidateArchitectureUnchangedConfig,
    ValidateNoArchitectureCyclesConfig,
    ValidatePackageJsonConfig,
    ValidateVersionsLockedConfig,
    ValidateEslintSyncConfig,
} from './rule-configs';
import { NoClientCreationOutsideServerOrClientConfig } from './no-client-creation-config';

// Thin lookup table — each entry delegates to the class's own SCHEMA.
// No field lists here; all schemas live with their config class.
export const RULE_SCHEMAS: Record<string, Record<string, FieldDef>> = {
    'max-method-lines': MaxMethodLinesConfig.SCHEMA,
    'max-file-lines': MaxFileLinesConfig.SCHEMA,
    'require-return-type': RequireReturnTypeConfig.SCHEMA,
    'no-inline-type-literals': NoInlineTypeLiteralsConfig.SCHEMA,
    'no-any-unknown': NoAnyUnknownConfig.SCHEMA,
    'no-implicit-any': NoImplicitAnyConfig.SCHEMA,
    'prisma-validate-dtos': PrismaValidateDtosConfig.SCHEMA,
    'prisma-converter': PrismaConverterConfig.SCHEMA,
    'no-destructure': NoDestructureConfig.SCHEMA,
    'no-unmanaged-exceptions': NoUnmanagedExceptionsConfig.SCHEMA,
    'catch-error-pattern': CatchErrorPatternConfig.SCHEMA,
    'throw-cause-required': ThrowCauseRequiredConfig.SCHEMA,
    'angular-no-direct-api-in-resolver': AngularNoDirectApiInResolverConfig.SCHEMA,
    'no-symbol-di-tokens': NoSymbolDiTokensConfig.SCHEMA,
    'no-client-creation-outside-server-or-client': NoClientCreationOutsideServerOrClientConfig.SCHEMA,
    'no-custom-css': NoCustomCssConfig.SCHEMA,
    'no-process-exit-outside-main': NoProcessExitOutsideMainConfig.SCHEMA,
    'no-function-outside-class': NoFunctionOutsideClassConfig.SCHEMA,
    'inject-annotation-not-needed-for-concrete-class': InjectAnnotationNotNeededForConcreteClassConfig.SCHEMA,
    'framework-tag': FrameworkTagConfig.SCHEMA,
    'role-tag': RoleTagConfig.SCHEMA,
    'branch-creation-guard': BranchCreationGuardConfig.SCHEMA,
    'pr-creation-or-push-guard': PrCreationOrPushGuardConfig.SCHEMA,
    'merge-in-progress-guard': MergeInProgressGuardConfig.SCHEMA,
    'pr-merge-guard': PrMergeGuardConfig.SCHEMA,
    'redirect-how-to-merge-main': RedirectHowToMergeMainConfig.SCHEMA,
    'whole-repo-build-guard': WholeRepoBuildGuardConfig.SCHEMA,
    'feature-branch-guard': FeatureBranchGuardConfig.SCHEMA,
    'read-stale-guard': ReadStaleGuardConfig.SCHEMA,
    'merged-branch-bash-guard': MergedBranchBashGuardConfig.SCHEMA,
    'stale-main-bash-guard': StaleMainBashGuardConfig.SCHEMA,
    'no-file-import-cycles': NoFileImportCyclesConfig.SCHEMA,
    'runtime-architecture': RuntimeArchitectureConfig.SCHEMA,
    'nx-wiring': NxWiringConfig.SCHEMA,
    'di-graph': DiGraphConfig.SCHEMA,
    'missing-design-annotation': MissingDesignAnnotationConfig.SCHEMA,
    'no-js-files': NoJsFilesConfig.SCHEMA,
    'validate-ts-in-src': ValidateTsInSrcConfig.SCHEMA,
    'validate-architecture-unchanged': ValidateArchitectureUnchangedConfig.SCHEMA,
    'validate-no-architecture-cycles': ValidateNoArchitectureCyclesConfig.SCHEMA,
    'validate-packagejson': ValidatePackageJsonConfig.SCHEMA,
    'validate-versions-locked': ValidateVersionsLockedConfig.SCHEMA,
    'validate-eslint-sync': ValidateEslintSyncConfig.SCHEMA,
};

// Every built-in rule name that has a typed schema (code rules + bash guards). The installer uses
// this (with sectionForRule) to seed a fresh webpieces.config.json with every rule in its section.
// webpieces-disable no-function-outside-class -- pure lookup over the module-scope schema table
export function allRuleNames(): readonly string[] {
    return Object.keys(RULE_SCHEMAS);
}
