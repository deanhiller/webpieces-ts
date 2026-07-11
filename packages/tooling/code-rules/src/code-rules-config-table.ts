import {
    BaseRuleConfig,
    WebpiecesRulesConfig,
    MaxMethodLinesConfig,
    MaxFileLinesConfig,
    RequireReturnTypeConfig,
    NoInlineTypeLiteralsConfig,
    NoAnyUnknownConfig,
    NoImplicitAnyConfig,
    PrismaValidateDtosConfig,
    PrismaConverterConfig,
    NoDestructureConfig,
    CatchErrorPatternConfig,
    NoUnmanagedExceptionsConfig,
    AngularNoDirectApiInResolverConfig,
    NoSymbolDiTokensConfig,
    NoProcessExitOutsideMainConfig,
    NoFunctionOutsideClassConfig,
    InjectAnnotationNotNeededForConcreteClassConfig,
    FrameworkTagConfig,
    RoleTagConfig,
} from '@webpieces/rules-config';

/** A rule config class usable as an inversify inject-by-type token. */
export type ConfigCtor = new () => BaseRuleConfig;

/**
 * The 1:1 table of `[config class, webpieces.config.json rule key]`. The composition root iterates it
 * to bind each rule's config into the container (`bind(ConfigClass).toConstantValue(config[key] ??
 * new ConfigClass())`), so every `@provideSingleton` validator injects its config by type. Data only
 * — the binding loop lives inline in the bin (an inline loop, exempt from no-function-outside-class).
 */
export const CONFIG_BINDINGS: ReadonlyArray<readonly [ConfigCtor, keyof WebpiecesRulesConfig]> = [
    [MaxMethodLinesConfig, 'max-method-lines'],
    [MaxFileLinesConfig, 'max-file-lines'],
    [RequireReturnTypeConfig, 'require-return-type'],
    [NoInlineTypeLiteralsConfig, 'no-inline-type-literals'],
    [NoAnyUnknownConfig, 'no-any-unknown'],
    [NoImplicitAnyConfig, 'no-implicit-any'],
    [PrismaValidateDtosConfig, 'prisma-validate-dtos'],
    [PrismaConverterConfig, 'prisma-converter'],
    [NoDestructureConfig, 'no-destructure'],
    [CatchErrorPatternConfig, 'catch-error-pattern'],
    [NoUnmanagedExceptionsConfig, 'no-unmanaged-exceptions'],
    [AngularNoDirectApiInResolverConfig, 'angular-no-direct-api-in-resolver'],
    [NoSymbolDiTokensConfig, 'no-symbol-di-tokens'],
    [NoProcessExitOutsideMainConfig, 'no-process-exit-outside-main'],
    [NoFunctionOutsideClassConfig, 'no-function-outside-class'],
    [InjectAnnotationNotNeededForConcreteClassConfig, 'inject-annotation-not-needed-for-concrete-class'],
    [FrameworkTagConfig, 'framework-tag'],
    [RoleTagConfig, 'role-tag'],
];
