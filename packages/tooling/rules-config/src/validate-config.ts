import { FieldDef } from './field-def';
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
    NoShellSubstitutionConfig,
    BranchCreationGuardConfig,
    PrCreationGuardConfig,
    PrMergeCleanupConfig,
    NoDirectMainUpdateConfig,
    NoEditOnMainConfig,
    NoFileImportCyclesConfig,
    RuntimeArchitectureConfig,
    NoJsFilesConfig,
    ValidateTsInSrcConfig,
} from './rule-configs';

// Thin lookup table — each entry delegates to the class's own SCHEMA.
// No field lists here; all schemas live with their config class.
const RULE_SCHEMAS: Record<string, Record<string, FieldDef>> = {
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
    'no-shell-substitution': NoShellSubstitutionConfig.SCHEMA,
    'branch-creation-guard': BranchCreationGuardConfig.SCHEMA,
    'pr-creation-guard': PrCreationGuardConfig.SCHEMA,
    'pr-merge-cleanup': PrMergeCleanupConfig.SCHEMA,
    'no-direct-main-update': NoDirectMainUpdateConfig.SCHEMA,
    'no-edit-on-main': NoEditOnMainConfig.SCHEMA,
    'no-file-import-cycles': NoFileImportCyclesConfig.SCHEMA,
    'runtime-architecture': RuntimeArchitectureConfig.SCHEMA,
    'no-js-files': NoJsFilesConfig.SCHEMA,
    'validate-ts-in-src': ValidateTsInSrcConfig.SCHEMA,
};

// webpieces-disable no-any-unknown -- rawRules values are opaque JSON; each field is validated individually
export function validateWebpiecesConfig(
    rawRules: Record<string, Record<string, unknown>>,
): string[] {
    const errors: string[] = [];
    for (const [ruleName, entry] of Object.entries(rawRules)) {
        const schema = RULE_SCHEMAS[ruleName];
        if (!schema) continue; // custom/unknown rule — no schema to validate against
        for (const [key, value] of Object.entries(entry)) {
            const fieldDef = schema[key];
            if (!fieldDef) {
                errors.push(`[${ruleName}] Unknown field "${key}". Valid fields: [${Object.keys(schema).join(', ')}]`);
                continue;
            }
            if (fieldDef.type === 'string[]') {
                if (!Array.isArray(value) || !value.every(v => typeof v === 'string'))
                    errors.push(`[${ruleName}] "${key}" must be string[], got ${typeof value}.`);
            } else if (typeof value !== fieldDef.type) {
                errors.push(`[${ruleName}] "${key}" must be ${fieldDef.type}, got ${typeof value}.`);
            } else if (fieldDef.enumValues && !fieldDef.enumValues.includes(value as string)) {
                errors.push(`[${ruleName}] "${key}" = "${value}" is not valid. Must be one of: ${fieldDef.enumValues.join(', ')}.`);
            }
        }
    }
    return errors;
}
