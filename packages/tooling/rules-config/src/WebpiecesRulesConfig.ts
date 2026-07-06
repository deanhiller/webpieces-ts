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
    EnforceControllerNamingConfig,
    FrameworkTagConfig,
    RoleTagConfig,
    BranchCreationGuardConfig,
    PrCreationOrPushGuardConfig,
    MergeInProgressGuardConfig,
    PrMergeGuardConfig,
    RedirectHowToMergeMainConfig,
    FeatureBranchGuardConfig,
    NoFileImportCyclesConfig,
    RuntimeArchitectureConfig,
    DiGraphConfig,
    NoJsFilesConfig,
    ValidateTsInSrcConfig,
} from './rule-configs';

export class WebpiecesRulesConfig {
    'max-method-lines'?: MaxMethodLinesConfig;
    'max-file-lines'?: MaxFileLinesConfig;
    'require-return-type'?: RequireReturnTypeConfig;
    'no-inline-type-literals'?: NoInlineTypeLiteralsConfig;
    'no-any-unknown'?: NoAnyUnknownConfig;
    'no-implicit-any'?: NoImplicitAnyConfig;
    'prisma-validate-dtos'?: PrismaValidateDtosConfig;
    'prisma-converter'?: PrismaConverterConfig;
    'no-destructure'?: NoDestructureConfig;
    'no-unmanaged-exceptions'?: NoUnmanagedExceptionsConfig;
    'catch-error-pattern'?: CatchErrorPatternConfig;
    'throw-cause-required'?: ThrowCauseRequiredConfig;
    'angular-no-direct-api-in-resolver'?: AngularNoDirectApiInResolverConfig;
    'no-symbol-di-tokens'?: NoSymbolDiTokensConfig;
    'enforce-controller-naming'?: EnforceControllerNamingConfig;
    'framework-tag'?: FrameworkTagConfig;
    'role-tag'?: RoleTagConfig;
    'branch-creation-guard'?: BranchCreationGuardConfig;
    'pr-creation-or-push-guard'?: PrCreationOrPushGuardConfig;
    'merge-in-progress-guard'?: MergeInProgressGuardConfig;
    'pr-merge-guard'?: PrMergeGuardConfig;
    'redirect-how-to-merge-main'?: RedirectHowToMergeMainConfig;
    'feature-branch-guard'?: FeatureBranchGuardConfig;
    'no-file-import-cycles'?: NoFileImportCyclesConfig;
    'runtime-architecture'?: RuntimeArchitectureConfig;
    'di-graph'?: DiGraphConfig;
    'no-js-files'?: NoJsFilesConfig;
    'validate-ts-in-src'?: ValidateTsInSrcConfig;
    rulesDir?: string[];
}
