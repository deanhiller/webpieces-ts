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
    DiGraphConfig,
    MissingDesignAnnotationConfig,
    NoJsFilesConfig,
    ValidateTsInSrcConfig,
} from './rule-configs';
import { BranchStateGuardConfig } from './main-sync-guard-configs';
import { NoClientCreationOutsideServerOrClientConfig } from './no-client-creation-config';
import { NoStatePathsInTemplatesConfig } from './no-state-paths-config';

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
    'no-client-creation-outside-server-or-client'?: NoClientCreationOutsideServerOrClientConfig;
    'no-custom-css'?: NoCustomCssConfig;
    'no-state-paths-in-templates'?: NoStatePathsInTemplatesConfig;
    'no-process-exit-outside-main'?: NoProcessExitOutsideMainConfig;
    'no-function-outside-class'?: NoFunctionOutsideClassConfig;
    'inject-annotation-not-needed-for-concrete-class'?: InjectAnnotationNotNeededForConcreteClassConfig;
    'framework-tag'?: FrameworkTagConfig;
    'role-tag'?: RoleTagConfig;
    // The THREE hookGuards keys, complete. It used to list five of the nine class-named keys — both
    // bash guards were simply missing — and nothing caught it, because this class is populated by
    // dynamic key assignment in the loader. One key per POLICY makes completeness checkable by eye.
    'branch-state-guard'?: BranchStateGuardConfig;
    'branch-creation-guard'?: BranchCreationGuardConfig;
    'pr-lifecycle-guard'?: PrLifecycleGuardConfig;
    'no-file-import-cycles'?: NoFileImportCyclesConfig;
    'runtime-architecture'?: RuntimeArchitectureConfig;
    'di-graph'?: DiGraphConfig;
    'missing-design-annotation'?: MissingDesignAnnotationConfig;
    'no-js-files'?: NoJsFilesConfig;
    'validate-ts-in-src'?: ValidateTsInSrcConfig;
    rulesDir?: string[];
}
