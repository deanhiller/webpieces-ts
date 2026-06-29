import { FieldDef, SchemaShape } from './field-def';

// Mode const arrays — TypeScript union types derived from them, and FieldDef enum
// values reference the same array. Impossible for the type and runtime check to diverge.

const METHOD_LIMIT_MODES = ['OFF', 'NEW_METHODS', 'NEW_AND_MODIFIED_METHODS', 'MODIFIED_FILES'] as const;
type MethodLimitMode = typeof METHOD_LIMIT_MODES[number];

const FILE_LIMIT_MODES = ['OFF', 'MODIFIED_FILES'] as const;
type FileLimitMode = typeof FILE_LIMIT_MODES[number];

const RETURN_TYPE_MODES = ['OFF', 'NEW_METHODS', 'NEW_AND_MODIFIED_METHODS', 'MODIFIED_FILES'] as const;
type ReturnTypeModeLocal = typeof RETURN_TYPE_MODES[number];

const INLINE_TYPE_MODES = ['OFF', 'NEW_METHODS', 'NEW_AND_MODIFIED_METHODS', 'MODIFIED_FILES'] as const;
type InlineTypeModeLocal = typeof INLINE_TYPE_MODES[number];

const MODIFIED_CODE_MODES = ['OFF', 'MODIFIED_CODE', 'MODIFIED_FILES'] as const;
type ModifiedCodeMode = typeof MODIFIED_CODE_MODES[number];

const PRISMA_DTOS_MODES = ['OFF', 'MODIFIED_CLASS', 'MODIFIED_FILES'] as const;
type PrismaValidateDtosMode = typeof PRISMA_DTOS_MODES[number];

const PRISMA_CONVERTER_MODES = ['OFF', 'NEW_AND_MODIFIED_METHODS', 'MODIFIED_FILES'] as const;
type PrismaConverterModeLocal = typeof PRISMA_CONVERTER_MODES[number];

const DIRECT_API_RESOLVER_MODES = ['OFF', 'MODIFIED_CODE', 'NEW_AND_MODIFIED_METHODS', 'MODIFIED_FILES'] as const;
type DirectApiResolverMode = typeof DIRECT_API_RESOLVER_MODES[number];

const THROW_CAUSE_MODES = ['ON', 'OFF', 'MODIFIED_CODE'] as const;
type ThrowCauseModeLocal = typeof THROW_CAUSE_MODES[number];

const ON_OFF_MODES = ['ON', 'OFF'] as const;
type OnOffMode = typeof ON_OFF_MODES[number];

const VALIDATE_TS_MODES = ['ON', 'OFF', 'MODIFIED_FILES'] as const;
type ValidateTsMode = typeof VALIDATE_TS_MODES[number];

// ---------------------------------------------------------------------------
// Universal escape hatches — EVERY rule supports temporarily disabling itself
// either while on a named git branch (ignoreRuleWhileOnBranch) or until an
// epoch passes (ignoreModifiedUntilEpoch). Both are optional. They live on a
// shared base class so the two fields (and their schema entries) are declared
// once instead of repeated per rule. `mode` stays per-rule because its allowed
// values vary (ON/OFF vs MODIFIED_CODE vs NEW_AND_MODIFIED_METHODS, etc).
// ---------------------------------------------------------------------------
export abstract class BaseRuleConfig {
    ignoreModifiedUntilEpoch?: number;
    ignoreRuleWhileOnBranch?: string;
}

export const BASE_RULE_SCHEMA = {
    ignoreModifiedUntilEpoch: FieldDef.optional('number'),
    ignoreRuleWhileOnBranch: FieldDef.optional('string'),
};

export class MaxMethodLinesConfig extends BaseRuleConfig {
    mode?: MethodLimitMode;
    limit?: number;
    disableAllowed?: boolean;

    static readonly SCHEMA: SchemaShape<MaxMethodLinesConfig> = {
        mode: new FieldDef('string', METHOD_LIMIT_MODES),
        limit: FieldDef.optional('number'),
        disableAllowed: FieldDef.optional('boolean'),
        ...BASE_RULE_SCHEMA,
    };
}

export class MaxFileLinesConfig extends BaseRuleConfig {
    mode?: FileLimitMode;
    limit?: number;
    disableAllowed?: boolean;

    static readonly SCHEMA: SchemaShape<MaxFileLinesConfig> = {
        mode: new FieldDef('string', FILE_LIMIT_MODES),
        limit: FieldDef.optional('number'),
        disableAllowed: FieldDef.optional('boolean'),
        ...BASE_RULE_SCHEMA,
    };
}

export class RequireReturnTypeConfig extends BaseRuleConfig {
    mode?: ReturnTypeModeLocal;
    disableAllowed?: boolean;

    static readonly SCHEMA: SchemaShape<RequireReturnTypeConfig> = {
        mode: new FieldDef('string', RETURN_TYPE_MODES),
        disableAllowed: FieldDef.optional('boolean'),
        ...BASE_RULE_SCHEMA,
    };
}

export class NoInlineTypeLiteralsConfig extends BaseRuleConfig {
    mode?: InlineTypeModeLocal;
    disableAllowed?: boolean;

    static readonly SCHEMA: SchemaShape<NoInlineTypeLiteralsConfig> = {
        mode: new FieldDef('string', INLINE_TYPE_MODES),
        disableAllowed: FieldDef.optional('boolean'),
        ...BASE_RULE_SCHEMA,
    };
}

export class NoAnyUnknownConfig extends BaseRuleConfig {
    mode?: ModifiedCodeMode;
    disableAllowed?: boolean;

    static readonly SCHEMA: SchemaShape<NoAnyUnknownConfig> = {
        mode: new FieldDef('string', MODIFIED_CODE_MODES),
        disableAllowed: FieldDef.optional('boolean'),
        ...BASE_RULE_SCHEMA,
    };
}

export class NoImplicitAnyConfig extends BaseRuleConfig {
    mode?: ModifiedCodeMode;
    disableAllowed?: boolean;

    static readonly SCHEMA: SchemaShape<NoImplicitAnyConfig> = {
        mode: new FieldDef('string', MODIFIED_CODE_MODES),
        disableAllowed: FieldDef.optional('boolean'),
        ...BASE_RULE_SCHEMA,
    };
}

export class PrismaValidateDtosConfig extends BaseRuleConfig {
    mode?: PrismaValidateDtosMode;
    disableAllowed?: boolean;
    prismaSchemaPath?: string;
    dtoSourcePaths?: string[];

    static readonly SCHEMA: SchemaShape<PrismaValidateDtosConfig> = {
        mode: new FieldDef('string', PRISMA_DTOS_MODES),
        disableAllowed: FieldDef.optional('boolean'),
        prismaSchemaPath: FieldDef.optional('string'),
        dtoSourcePaths: FieldDef.optional('string[]'),
        ...BASE_RULE_SCHEMA,
    };
}

export class PrismaConverterConfig extends BaseRuleConfig {
    mode?: PrismaConverterModeLocal;
    disableAllowed?: boolean;
    schemaPath?: string;
    convertersPaths?: string[];
    enforcePaths?: string[];

    static readonly SCHEMA: SchemaShape<PrismaConverterConfig> = {
        mode: new FieldDef('string', PRISMA_CONVERTER_MODES),
        disableAllowed: FieldDef.optional('boolean'),
        schemaPath: FieldDef.optional('string'),
        convertersPaths: FieldDef.optional('string[]'),
        enforcePaths: FieldDef.optional('string[]'),
        ...BASE_RULE_SCHEMA,
    };
}

export class NoDestructureConfig extends BaseRuleConfig {
    mode?: ModifiedCodeMode;
    allowTopLevel?: boolean;
    disableAllowed?: boolean;

    static readonly SCHEMA: SchemaShape<NoDestructureConfig> = {
        mode: new FieldDef('string', MODIFIED_CODE_MODES),
        allowTopLevel: FieldDef.optional('boolean'),
        disableAllowed: FieldDef.optional('boolean'),
        ...BASE_RULE_SCHEMA,
    };
}

export class NoUnmanagedExceptionsConfig extends BaseRuleConfig {
    mode?: ModifiedCodeMode;
    disableAllowed?: boolean;

    static readonly SCHEMA: SchemaShape<NoUnmanagedExceptionsConfig> = {
        mode: new FieldDef('string', MODIFIED_CODE_MODES),
        disableAllowed: FieldDef.optional('boolean'),
        ...BASE_RULE_SCHEMA,
    };
}

export class CatchErrorPatternConfig extends BaseRuleConfig {
    mode?: ModifiedCodeMode;
    disableAllowed?: boolean;

    static readonly SCHEMA: SchemaShape<CatchErrorPatternConfig> = {
        mode: new FieldDef('string', MODIFIED_CODE_MODES),
        disableAllowed: FieldDef.optional('boolean'),
        ...BASE_RULE_SCHEMA,
    };
}

export class ThrowCauseRequiredConfig extends BaseRuleConfig {
    mode?: ThrowCauseModeLocal;
    disableAllowed?: boolean;

    static readonly SCHEMA: SchemaShape<ThrowCauseRequiredConfig> = {
        mode: new FieldDef('string', THROW_CAUSE_MODES),
        disableAllowed: FieldDef.optional('boolean'),
        ...BASE_RULE_SCHEMA,
    };
}

export class AngularNoDirectApiInResolverConfig extends BaseRuleConfig {
    mode?: DirectApiResolverMode;
    disableAllowed?: boolean;
    enforcePaths?: string[];

    static readonly SCHEMA: SchemaShape<AngularNoDirectApiInResolverConfig> = {
        mode: new FieldDef('string', DIRECT_API_RESOLVER_MODES),
        disableAllowed: FieldDef.optional('boolean'),
        enforcePaths: FieldDef.optional('string[]'),
        ...BASE_RULE_SCHEMA,
    };
}

export class NoSymbolDiTokensConfig extends BaseRuleConfig {
    mode?: ModifiedCodeMode;
    disableAllowed?: boolean;
    allowedPaths?: string[];

    static readonly SCHEMA: SchemaShape<NoSymbolDiTokensConfig> = {
        mode: new FieldDef('string', MODIFIED_CODE_MODES),
        disableAllowed: FieldDef.optional('boolean'),
        allowedPaths: FieldDef.optional('string[]'),
        ...BASE_RULE_SCHEMA,
    };
}

export class NoShellSubstitutionConfig extends BaseRuleConfig {
    mode?: OnOffMode;

    static readonly SCHEMA: SchemaShape<NoShellSubstitutionConfig> = {
        mode: new FieldDef('string', ON_OFF_MODES),
        ...BASE_RULE_SCHEMA,
    };
}

export class BranchCreationGuardConfig extends BaseRuleConfig {
    mode?: OnOffMode;
    subBranchNaming?: string;

    static readonly SCHEMA: SchemaShape<BranchCreationGuardConfig> = {
        mode: new FieldDef('string', ON_OFF_MODES),
        subBranchNaming: FieldDef.optional('string'),
        ...BASE_RULE_SCHEMA,
    };
}

export class PrCreationGuardConfig extends BaseRuleConfig {
    mode?: OnOffMode;

    static readonly SCHEMA: SchemaShape<PrCreationGuardConfig> = {
        mode: new FieldDef('string', ON_OFF_MODES),
        ...BASE_RULE_SCHEMA,
    };
}

export class MergeInProgressGuardConfig extends BaseRuleConfig {
    mode?: OnOffMode;

    static readonly SCHEMA: SchemaShape<MergeInProgressGuardConfig> = {
        mode: new FieldDef('string', ON_OFF_MODES),
        ...BASE_RULE_SCHEMA,
    };
}

export class PrMergeCleanupConfig extends BaseRuleConfig {
    mode?: OnOffMode;

    static readonly SCHEMA: SchemaShape<PrMergeCleanupConfig> = {
        mode: new FieldDef('string', ON_OFF_MODES),
        ...BASE_RULE_SCHEMA,
    };
}

export class NoDirectMainUpdateConfig extends BaseRuleConfig {
    mode?: OnOffMode;

    static readonly SCHEMA: SchemaShape<NoDirectMainUpdateConfig> = {
        mode: new FieldDef('string', ON_OFF_MODES),
        ...BASE_RULE_SCHEMA,
    };
}

export class NoEditOnMainConfig extends BaseRuleConfig {
    mode?: OnOffMode;
    branchNamingConvention?: string;

    static readonly SCHEMA: SchemaShape<NoEditOnMainConfig> = {
        mode: new FieldDef('string', ON_OFF_MODES),
        branchNamingConvention: FieldDef.optional('string'),
        ...BASE_RULE_SCHEMA,
    };
}

export class NoFileImportCyclesConfig extends BaseRuleConfig {
    mode?: OnOffMode;
    ignoreTypeOnly?: boolean;
    excludePackages?: string[];

    static readonly SCHEMA: SchemaShape<NoFileImportCyclesConfig> = {
        mode: new FieldDef('string', ON_OFF_MODES),
        ignoreTypeOnly: FieldDef.optional('boolean'),
        excludePackages: FieldDef.optional('string[]'),
        ...BASE_RULE_SCHEMA,
    };
}

export class RuntimeArchitectureConfig extends BaseRuleConfig {
    mode?: OnOffMode;
    servicePaths?: string[];
    apiProjectPaths?: string[];
    allowedCycles?: string[];

    static readonly SCHEMA: SchemaShape<RuntimeArchitectureConfig> = {
        mode: new FieldDef('string', ON_OFF_MODES),
        servicePaths: FieldDef.optional('string[]'),
        apiProjectPaths: FieldDef.optional('string[]'),
        allowedCycles: FieldDef.optional('string[]'),
        ...BASE_RULE_SCHEMA,
    };
}

export class NoJsFilesConfig extends BaseRuleConfig {
    mode?: OnOffMode;
    allowedPaths?: string[];

    static readonly SCHEMA: SchemaShape<NoJsFilesConfig> = {
        mode: new FieldDef('string', ON_OFF_MODES),
        allowedPaths: FieldDef.optional('string[]'),
        ...BASE_RULE_SCHEMA,
    };
}

export class ValidateTsInSrcConfig extends BaseRuleConfig {
    mode?: ValidateTsMode;
    allowedRootFiles?: string[];
    excludePaths?: string[];

    static readonly SCHEMA: SchemaShape<ValidateTsInSrcConfig> = {
        mode: new FieldDef('string', VALIDATE_TS_MODES),
        allowedRootFiles: FieldDef.optional('string[]'),
        excludePaths: FieldDef.optional('string[]'),
        ...BASE_RULE_SCHEMA,
    };
}
