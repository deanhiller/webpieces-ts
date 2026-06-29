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
    MergeInProgressGuardConfig,
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
    'merge-in-progress-guard': MergeInProgressGuardConfig.SCHEMA,
    'pr-merge-cleanup': PrMergeCleanupConfig.SCHEMA,
    'no-direct-main-update': NoDirectMainUpdateConfig.SCHEMA,
    'no-edit-on-main': NoEditOnMainConfig.SCHEMA,
    'no-file-import-cycles': NoFileImportCyclesConfig.SCHEMA,
    'runtime-architecture': RuntimeArchitectureConfig.SCHEMA,
    'no-js-files': NoJsFilesConfig.SCHEMA,
    'validate-ts-in-src': ValidateTsInSrcConfig.SCHEMA,
};

function valueHint(def: FieldDef): string {
    return def.enumValues
        ? `"${def.enumValues.join(' | ')}"`
        : def.type === 'string[]' ? '["<string>", ...]'
        : def.type === 'number'   ? '<number>'
        : def.type === 'boolean'  ? '<boolean>'
        : '"<string>"';
}

function missingRuleSnippet(ruleName: string, schema: Record<string, FieldDef>): string {
    // Only required fields go in the copy-paste entry. Optional fields (e.g. the
    // universal escape hatches ignoreRuleWhileOnBranch / ignoreModifiedUntilEpoch)
    // are listed separately so the snippet doesn't over-state what's mandatory.
    const fields = Object.keys(schema);
    const required = fields.filter(f => !schema[f].optional);
    const optional = fields.filter(f => schema[f].optional);

    const requiredLines = required.map(f => `    "${f}": ${valueHint(schema[f])}`);
    let out =
        `[${ruleName}] Not configured in webpieces.config.json. Add this entry to the "rules" section\n` +
        `(choose values appropriate for your project):\n\n` +
        `  "${ruleName}": {\n${requiredLines.join(',\n')}\n  }`;

    if (optional.length > 0) {
        const optionalLines = optional.map(f => `    "${f}": ${valueHint(schema[f])}`);
        out +=
            `\n\nOptional fields you may add to this rule (omit if not needed):\n` +
            `${optionalLines.join(',\n')}`;
    }
    return out;
}

// webpieces-disable no-any-unknown -- rawRules values are opaque JSON; each field is validated individually
export function validateWebpiecesConfig(
    rawRules: Record<string, Record<string, unknown>>,
): string[] {
    const errors: string[] = [];

    // Check field-level correctness for rules that are present
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

    // Every built-in rule must be explicitly configured — no silent defaults.
    // When a new rule is added to the framework, this check surfaces it immediately
    // with a ready-to-copy snippet so AI can configure it in one pass.
    for (const [ruleName, schema] of Object.entries(RULE_SCHEMAS)) {
        if (!(ruleName in rawRules)) {
            errors.push(missingRuleSnippet(ruleName, schema));
        }
    }

    return errors;
}
