// The rule-name -> schema lookup table, split out of validate-config.ts (which hit the 700-line cap).
// Every consumer of "what fields does rule X have" reads it from here: the validator, the missing-rule
// snippet, and the installer's seeding (seed-entry.ts) — one table, so they cannot disagree.
import { FieldDef } from './field-def';
import { BranchStateGuardConfig } from './main-sync-guard-configs';
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
    PrLifecycleGuardConfig,
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
import { NoStatePathsInTemplatesConfig } from './no-state-paths-config';

// Thin lookup table — each entry delegates to the class's own SCHEMA.
// No field lists here; all schemas live with their config class.
//
// KEYED BY CONFIG KEY, not by rule name. For most rules those are the same string, but the three
// hookGuard entries below are POLICIES implemented by more than one class: `branch-state-guard` is
// read by the four branch-state guards and `pr-lifecycle-guard` by the four PR-lifecycle guards (see
// AbstractRule.configKey). A rule NAME that is not a config key has no row here and never should.
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
    'no-state-paths-in-templates': NoStatePathsInTemplatesConfig.SCHEMA,
    'no-process-exit-outside-main': NoProcessExitOutsideMainConfig.SCHEMA,
    'no-function-outside-class': NoFunctionOutsideClassConfig.SCHEMA,
    'inject-annotation-not-needed-for-concrete-class': InjectAnnotationNotNeededForConcreteClassConfig.SCHEMA,
    'framework-tag': FrameworkTagConfig.SCHEMA,
    'role-tag': RoleTagConfig.SCHEMA,
    'branch-creation-guard': BranchCreationGuardConfig.SCHEMA,
    'pr-lifecycle-guard': PrLifecycleGuardConfig.SCHEMA,
    'branch-state-guard': BranchStateGuardConfig.SCHEMA,
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

/**
 * The field names `configKey`'s schema accepts, or null when there is no schema (a custom rule from
 * `rulesDir`, or a name that is not a config key at all).
 *
 * Exists so the installer's N→1 retirement merge can drop fields the DESTINATION schema does not know
 * — `upsertPrCommand` folded from a retired guard entry into `pr-lifecycle-guard` would otherwise
 * produce a config the validator rejects on the very next call. Returning the names rather than the
 * FieldDefs keeps the schema objects themselves unexported: there is one reader of a schema's shape,
 * and it is this package's own validator.
 */
// webpieces-disable no-function-outside-class -- pure lookup over the module-scope schema table, beside allRuleNames
export function schemaFieldNames(configKey: string): readonly string[] | null {
    const schema = RULE_SCHEMAS[configKey];
    return schema === undefined ? null : Object.keys(schema);
}

// Every built-in CONFIG KEY that has a typed schema (code rules + bash guards). The installer uses
// this (with sectionForRule) to seed a fresh webpieces.config.json with every entry in its section.
// It is the key set, not the class set: four classes behind `branch-state-guard` contribute one name.
// webpieces-disable no-function-outside-class -- pure lookup over the module-scope schema table
export function allRuleNames(): readonly string[] {
    return Object.keys(RULE_SCHEMAS);
}
