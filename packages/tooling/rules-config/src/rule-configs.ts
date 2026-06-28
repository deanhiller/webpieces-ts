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

export class MaxMethodLinesConfig {
    mode?: MethodLimitMode;
    limit?: number;
    disableAllowed?: boolean;
    ignoreModifiedUntilEpoch?: number;
    ignoreRuleWhileOnBranch?: string;

    static readonly SCHEMA: SchemaShape<MaxMethodLinesConfig> = {
        mode: new FieldDef('string', METHOD_LIMIT_MODES),
        limit: new FieldDef('number'),
        disableAllowed: new FieldDef('boolean'),
        ignoreModifiedUntilEpoch: new FieldDef('number'),
        ignoreRuleWhileOnBranch: new FieldDef('string'),
    };
}

export class MaxFileLinesConfig {
    mode?: FileLimitMode;
    limit?: number;
    disableAllowed?: boolean;
    ignoreModifiedUntilEpoch?: number;
    ignoreRuleWhileOnBranch?: string;

    static readonly SCHEMA: SchemaShape<MaxFileLinesConfig> = {
        mode: new FieldDef('string', FILE_LIMIT_MODES),
        limit: new FieldDef('number'),
        disableAllowed: new FieldDef('boolean'),
        ignoreModifiedUntilEpoch: new FieldDef('number'),
        ignoreRuleWhileOnBranch: new FieldDef('string'),
    };
}

export class RequireReturnTypeConfig {
    mode?: ReturnTypeModeLocal;
    disableAllowed?: boolean;
    ignoreModifiedUntilEpoch?: number;
    ignoreRuleWhileOnBranch?: string;

    static readonly SCHEMA: SchemaShape<RequireReturnTypeConfig> = {
        mode: new FieldDef('string', RETURN_TYPE_MODES),
        disableAllowed: new FieldDef('boolean'),
        ignoreModifiedUntilEpoch: new FieldDef('number'),
        ignoreRuleWhileOnBranch: new FieldDef('string'),
    };
}

export class NoInlineTypeLiteralsConfig {
    mode?: InlineTypeModeLocal;
    disableAllowed?: boolean;
    ignoreModifiedUntilEpoch?: number;
    ignoreRuleWhileOnBranch?: string;

    static readonly SCHEMA: SchemaShape<NoInlineTypeLiteralsConfig> = {
        mode: new FieldDef('string', INLINE_TYPE_MODES),
        disableAllowed: new FieldDef('boolean'),
        ignoreModifiedUntilEpoch: new FieldDef('number'),
        ignoreRuleWhileOnBranch: new FieldDef('string'),
    };
}

export class NoAnyUnknownConfig {
    mode?: ModifiedCodeMode;
    disableAllowed?: boolean;
    ignoreModifiedUntilEpoch?: number;
    ignoreRuleWhileOnBranch?: string;

    static readonly SCHEMA: SchemaShape<NoAnyUnknownConfig> = {
        mode: new FieldDef('string', MODIFIED_CODE_MODES),
        disableAllowed: new FieldDef('boolean'),
        ignoreModifiedUntilEpoch: new FieldDef('number'),
        ignoreRuleWhileOnBranch: new FieldDef('string'),
    };
}

export class NoImplicitAnyConfig {
    mode?: ModifiedCodeMode;
    disableAllowed?: boolean;
    ignoreModifiedUntilEpoch?: number;
    ignoreRuleWhileOnBranch?: string;

    static readonly SCHEMA: SchemaShape<NoImplicitAnyConfig> = {
        mode: new FieldDef('string', MODIFIED_CODE_MODES),
        disableAllowed: new FieldDef('boolean'),
        ignoreModifiedUntilEpoch: new FieldDef('number'),
        ignoreRuleWhileOnBranch: new FieldDef('string'),
    };
}

export class PrismaValidateDtosConfig {
    mode?: PrismaValidateDtosMode;
    disableAllowed?: boolean;
    prismaSchemaPath?: string;
    dtoSourcePaths?: string[];
    ignoreModifiedUntilEpoch?: number;
    ignoreRuleWhileOnBranch?: string;

    static readonly SCHEMA: SchemaShape<PrismaValidateDtosConfig> = {
        mode: new FieldDef('string', PRISMA_DTOS_MODES),
        disableAllowed: new FieldDef('boolean'),
        prismaSchemaPath: new FieldDef('string'),
        dtoSourcePaths: new FieldDef('string[]'),
        ignoreModifiedUntilEpoch: new FieldDef('number'),
        ignoreRuleWhileOnBranch: new FieldDef('string'),
    };
}

export class PrismaConverterConfig {
    mode?: PrismaConverterModeLocal;
    disableAllowed?: boolean;
    schemaPath?: string;
    convertersPaths?: string[];
    enforcePaths?: string[];
    ignoreModifiedUntilEpoch?: number;
    ignoreRuleWhileOnBranch?: string;

    static readonly SCHEMA: SchemaShape<PrismaConverterConfig> = {
        mode: new FieldDef('string', PRISMA_CONVERTER_MODES),
        disableAllowed: new FieldDef('boolean'),
        schemaPath: new FieldDef('string'),
        convertersPaths: new FieldDef('string[]'),
        enforcePaths: new FieldDef('string[]'),
        ignoreModifiedUntilEpoch: new FieldDef('number'),
        ignoreRuleWhileOnBranch: new FieldDef('string'),
    };
}

export class NoDestructureConfig {
    mode?: ModifiedCodeMode;
    allowTopLevel?: boolean;
    disableAllowed?: boolean;
    ignoreModifiedUntilEpoch?: number;
    ignoreRuleWhileOnBranch?: string;

    static readonly SCHEMA: SchemaShape<NoDestructureConfig> = {
        mode: new FieldDef('string', MODIFIED_CODE_MODES),
        allowTopLevel: new FieldDef('boolean'),
        disableAllowed: new FieldDef('boolean'),
        ignoreModifiedUntilEpoch: new FieldDef('number'),
        ignoreRuleWhileOnBranch: new FieldDef('string'),
    };
}

export class NoUnmanagedExceptionsConfig {
    mode?: ModifiedCodeMode;
    disableAllowed?: boolean;
    ignoreModifiedUntilEpoch?: number;
    ignoreRuleWhileOnBranch?: string;

    static readonly SCHEMA: SchemaShape<NoUnmanagedExceptionsConfig> = {
        mode: new FieldDef('string', MODIFIED_CODE_MODES),
        disableAllowed: new FieldDef('boolean'),
        ignoreModifiedUntilEpoch: new FieldDef('number'),
        ignoreRuleWhileOnBranch: new FieldDef('string'),
    };
}

export class CatchErrorPatternConfig {
    mode?: ModifiedCodeMode;
    disableAllowed?: boolean;
    ignoreModifiedUntilEpoch?: number;
    ignoreRuleWhileOnBranch?: string;

    static readonly SCHEMA: SchemaShape<CatchErrorPatternConfig> = {
        mode: new FieldDef('string', MODIFIED_CODE_MODES),
        disableAllowed: new FieldDef('boolean'),
        ignoreModifiedUntilEpoch: new FieldDef('number'),
        ignoreRuleWhileOnBranch: new FieldDef('string'),
    };
}

export class ThrowCauseRequiredConfig {
    mode?: ThrowCauseModeLocal;
    disableAllowed?: boolean;
    ignoreModifiedUntilEpoch?: number;
    ignoreRuleWhileOnBranch?: string;

    static readonly SCHEMA: SchemaShape<ThrowCauseRequiredConfig> = {
        mode: new FieldDef('string', THROW_CAUSE_MODES),
        disableAllowed: new FieldDef('boolean'),
        ignoreModifiedUntilEpoch: new FieldDef('number'),
        ignoreRuleWhileOnBranch: new FieldDef('string'),
    };
}

export class AngularNoDirectApiInResolverConfig {
    mode?: DirectApiResolverMode;
    disableAllowed?: boolean;
    ignoreModifiedUntilEpoch?: number;
    ignoreRuleWhileOnBranch?: string;
    enforcePaths?: string[];

    static readonly SCHEMA: SchemaShape<AngularNoDirectApiInResolverConfig> = {
        mode: new FieldDef('string', DIRECT_API_RESOLVER_MODES),
        disableAllowed: new FieldDef('boolean'),
        ignoreModifiedUntilEpoch: new FieldDef('number'),
        ignoreRuleWhileOnBranch: new FieldDef('string'),
        enforcePaths: new FieldDef('string[]'),
    };
}

export class NoSymbolDiTokensConfig {
    mode?: ModifiedCodeMode;
    disableAllowed?: boolean;
    ignoreModifiedUntilEpoch?: number;
    ignoreRuleWhileOnBranch?: string;
    allowedPaths?: string[];

    static readonly SCHEMA: SchemaShape<NoSymbolDiTokensConfig> = {
        mode: new FieldDef('string', MODIFIED_CODE_MODES),
        disableAllowed: new FieldDef('boolean'),
        ignoreModifiedUntilEpoch: new FieldDef('number'),
        ignoreRuleWhileOnBranch: new FieldDef('string'),
        allowedPaths: new FieldDef('string[]'),
    };
}

export class NoShellSubstitutionConfig {
    mode?: OnOffMode;

    static readonly SCHEMA: SchemaShape<NoShellSubstitutionConfig> = {
        mode: new FieldDef('string', ON_OFF_MODES),
    };
}

export class BranchCreationGuardConfig {
    mode?: OnOffMode;
    subBranchNaming?: string;

    static readonly SCHEMA: SchemaShape<BranchCreationGuardConfig> = {
        mode: new FieldDef('string', ON_OFF_MODES),
        subBranchNaming: new FieldDef('string'),
    };
}

export class PrCreationGuardConfig {
    mode?: OnOffMode;
    buildCommand?: string;
    requireTextInPr?: string;

    static readonly SCHEMA: SchemaShape<PrCreationGuardConfig> = {
        mode: new FieldDef('string', ON_OFF_MODES),
        buildCommand: new FieldDef('string'),
        requireTextInPr: new FieldDef('string'),
    };
}

export class PrMergeCleanupConfig {
    mode?: OnOffMode;

    static readonly SCHEMA: SchemaShape<PrMergeCleanupConfig> = {
        mode: new FieldDef('string', ON_OFF_MODES),
    };
}

export class NoDirectMainUpdateConfig {
    mode?: OnOffMode;

    static readonly SCHEMA: SchemaShape<NoDirectMainUpdateConfig> = {
        mode: new FieldDef('string', ON_OFF_MODES),
    };
}

export class NoEditOnMainConfig {
    mode?: OnOffMode;
    branchNamingConvention?: string;

    static readonly SCHEMA: SchemaShape<NoEditOnMainConfig> = {
        mode: new FieldDef('string', ON_OFF_MODES),
        branchNamingConvention: new FieldDef('string'),
    };
}

export class NoFileImportCyclesConfig {
    mode?: OnOffMode;
    ignoreTypeOnly?: boolean;

    static readonly SCHEMA: SchemaShape<NoFileImportCyclesConfig> = {
        mode: new FieldDef('string', ON_OFF_MODES),
        ignoreTypeOnly: new FieldDef('boolean'),
    };
}

export class RuntimeArchitectureConfig {
    mode?: OnOffMode;
    servicePaths?: string[];
    apiProjectPaths?: string[];
    allowedCycles?: string[];

    static readonly SCHEMA: SchemaShape<RuntimeArchitectureConfig> = {
        mode: new FieldDef('string', ON_OFF_MODES),
        servicePaths: new FieldDef('string[]'),
        apiProjectPaths: new FieldDef('string[]'),
        allowedCycles: new FieldDef('string[]'),
    };
}

export class NoJsFilesConfig {
    mode?: OnOffMode;
    allowedPaths?: string[];

    static readonly SCHEMA: SchemaShape<NoJsFilesConfig> = {
        mode: new FieldDef('string', ON_OFF_MODES),
        allowedPaths: new FieldDef('string[]'),
    };
}

export class ValidateTsInSrcConfig {
    mode?: ValidateTsMode;
    ignoreModifiedUntilEpoch?: number;
    allowedRootFiles?: string[];
    excludePaths?: string[];

    static readonly SCHEMA: SchemaShape<ValidateTsInSrcConfig> = {
        mode: new FieldDef('string', VALIDATE_TS_MODES),
        ignoreModifiedUntilEpoch: new FieldDef('number'),
        allowedRootFiles: new FieldDef('string[]'),
        excludePaths: new FieldDef('string[]'),
    };
}
