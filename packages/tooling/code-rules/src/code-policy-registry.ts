import { BaseRuleConfig, FieldDef, BuildPolicy } from '@webpieces/rules-sdk';
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
    CatchErrorPatternConfig,
    NoUnmanagedExceptionsConfig,
    AngularNoDirectApiInResolverConfig,
    NoSymbolDiTokensConfig,
    NoCustomCssConfig,
    NoProcessExitOutsideMainConfig,
    NoFunctionOutsideClassConfig,
    InjectAnnotationNotNeededForConcreteClassConfig,
    FrameworkTagConfig,
    RoleTagConfig,
    EnsureWeAreSecureConfig,
} from './configs/rule-configs';
import { NoClientCreationOutsideServerOrClientConfig } from './configs/no-client-creation-config';
import { NoStatePathsInTemplatesConfig } from './configs/no-state-paths-config';
import {
    NoInlineImportInApiLibConfig,
    OneEnumSpellingInApiLibConfig,
} from './configs/api-lib-spelling-configs';
import { NoUtilityTypesInApiLibConfig } from './configs/no-utility-types-config';
import { RequiredTypeSuffixConfig } from './configs/required-type-suffix-config';
import { FrameworkTsconfigConfig, FrameworkPackagesConfig } from './configs/tag-truth-configs';

/** The owner entry declares both its schema token and executable validator. */
export type ConfigCtor = new () => BaseRuleConfig;

export type ValidatorCtor = new (...args: never[]) => BuildPolicy;

export class CodePolicy {
    // eslint-disable-next-line @typescript-eslint/max-params
    constructor(
        readonly configClass: ConfigCtor,
        readonly ruleId: string,
        readonly loadValidator: () => Promise<ValidatorCtor>,
        readonly schema: Readonly<Record<string, FieldDef>>,
    ) {}
}

export const CODE_POLICIES: readonly CodePolicy[] = [
    new CodePolicy(
        MaxMethodLinesConfig,
        'max-method-lines',
        async () => (await import('./validate-modified-methods')).MaxMethodLinesValidator,
        MaxMethodLinesConfig.SCHEMA,
    ),
    new CodePolicy(
        MaxFileLinesConfig,
        'max-file-lines',
        async () => (await import('./validate-modified-files')).MaxFileLinesValidator,
        MaxFileLinesConfig.SCHEMA,
    ),
    new CodePolicy(
        RequireReturnTypeConfig,
        'require-return-type',
        async () => (await import('./validate-return-types')).RequireReturnTypeValidator,
        RequireReturnTypeConfig.SCHEMA,
    ),
    new CodePolicy(
        NoInlineTypeLiteralsConfig,
        'no-inline-type-literals',
        async () => (await import('./validate-no-inline-types')).NoInlineTypeLiteralsValidator,
        NoInlineTypeLiteralsConfig.SCHEMA,
    ),
    new CodePolicy(
        NoAnyUnknownConfig,
        'no-any-unknown',
        async () => (await import('./validate-no-any-unknown')).NoAnyUnknownValidator,
        NoAnyUnknownConfig.SCHEMA,
    ),
    new CodePolicy(
        NoImplicitAnyConfig,
        'no-implicit-any',
        async () => (await import('./validate-no-implicit-any')).NoImplicitAnyValidator,
        NoImplicitAnyConfig.SCHEMA,
    ),
    new CodePolicy(
        PrismaValidateDtosConfig,
        'prisma-validate-dtos',
        async () => (await import('./validate-dtos')).PrismaValidateDtosValidator,
        PrismaValidateDtosConfig.SCHEMA,
    ),
    new CodePolicy(
        PrismaConverterConfig,
        'prisma-converter',
        async () => (await import('./validate-prisma-converters')).PrismaConverterValidator,
        PrismaConverterConfig.SCHEMA,
    ),
    new CodePolicy(
        NoDestructureConfig,
        'no-destructure',
        async () => (await import('./validate-no-destructure')).NoDestructureValidator,
        NoDestructureConfig.SCHEMA,
    ),
    new CodePolicy(
        CatchErrorPatternConfig,
        'catch-error-pattern',
        async () => (await import('./validate-catch-error-pattern')).CatchErrorPatternValidator,
        CatchErrorPatternConfig.SCHEMA,
    ),
    new CodePolicy(
        NoUnmanagedExceptionsConfig,
        'no-unmanaged-exceptions',
        async () =>
            (await import('./validate-no-unmanaged-exceptions')).NoUnmanagedExceptionsValidator,
        NoUnmanagedExceptionsConfig.SCHEMA,
    ),
    new CodePolicy(
        AngularNoDirectApiInResolverConfig,
        'angular-no-direct-api-in-resolver',
        async () =>
            (await import('./validate-no-direct-api-resolver')).NoDirectApiResolverValidator,
        AngularNoDirectApiInResolverConfig.SCHEMA,
    ),
    new CodePolicy(
        NoSymbolDiTokensConfig,
        'no-symbol-di-tokens',
        async () => (await import('./validate-no-symbol-di-tokens')).NoSymbolDiTokensValidator,
        NoSymbolDiTokensConfig.SCHEMA,
    ),
    new CodePolicy(
        NoClientCreationOutsideServerOrClientConfig,
        'no-client-creation-outside-server-or-client',
        async () =>
            (await import('./validate-no-client-creation-outside-server-or-client'))
                .NoClientCreationOutsideServerOrClientValidator,
        NoClientCreationOutsideServerOrClientConfig.SCHEMA,
    ),
    new CodePolicy(
        NoCustomCssConfig,
        'no-custom-css',
        async () => (await import('./validate-no-custom-css')).NoCustomCssValidator,
        NoCustomCssConfig.SCHEMA,
    ),
    new CodePolicy(
        NoStatePathsInTemplatesConfig,
        'no-state-paths-in-templates',
        async () =>
            (await import('./validate-no-state-paths-in-templates'))
                .NoStatePathsInTemplatesValidator,
        NoStatePathsInTemplatesConfig.SCHEMA,
    ),
    new CodePolicy(
        NoProcessExitOutsideMainConfig,
        'no-process-exit-outside-main',
        async () =>
            (await import('./validate-no-process-exit-outside-main'))
                .NoProcessExitOutsideMainValidator,
        NoProcessExitOutsideMainConfig.SCHEMA,
    ),
    new CodePolicy(
        NoFunctionOutsideClassConfig,
        'no-function-outside-class',
        async () =>
            (await import('./validate-no-function-outside-class')).NoFunctionOutsideClassValidator,
        NoFunctionOutsideClassConfig.SCHEMA,
    ),
    new CodePolicy(
        InjectAnnotationNotNeededForConcreteClassConfig,
        'inject-annotation-not-needed-for-concrete-class',
        async () =>
            (await import('./validate-inject-annotation-not-needed-for-concrete-class'))
                .InjectAnnotationNotNeededForConcreteClassValidator,
        InjectAnnotationNotNeededForConcreteClassConfig.SCHEMA,
    ),
    new CodePolicy(
        FrameworkTagConfig,
        'framework-tag',
        async () => (await import('./validate-framework-tag')).FrameworkTagValidator,
        FrameworkTagConfig.SCHEMA,
    ),
    new CodePolicy(
        RoleTagConfig,
        'role-tag',
        async () => (await import('./validate-role-tag')).RoleTagValidator,
        RoleTagConfig.SCHEMA,
    ),
    new CodePolicy(
        EnsureWeAreSecureConfig,
        'ensure-we-are-secure',
        async () => (await import('./validate-ensure-we-are-secure')).EnsureWeAreSecureValidator,
        EnsureWeAreSecureConfig.SCHEMA,
    ),
    new CodePolicy(
        NoInlineImportInApiLibConfig,
        'no-inline-import-in-api-lib',
        async () =>
            (await import('./validate-no-inline-import-in-api-lib'))
                .NoInlineImportInApiLibValidator,
        NoInlineImportInApiLibConfig.SCHEMA,
    ),
    new CodePolicy(
        OneEnumSpellingInApiLibConfig,
        'one-enum-spelling-in-api-lib',
        async () =>
            (await import('./validate-one-enum-spelling-in-api-lib'))
                .OneEnumSpellingInApiLibValidator,
        OneEnumSpellingInApiLibConfig.SCHEMA,
    ),
    new CodePolicy(
        NoUtilityTypesInApiLibConfig,
        'no-utility-types-in-api-lib',
        async () =>
            (await import('./validate-no-utility-types-in-api-lib'))
                .NoUtilityTypesInApiLibValidator,
        NoUtilityTypesInApiLibConfig.SCHEMA,
    ),
    new CodePolicy(
        RequiredTypeSuffixConfig,
        'required-type-suffix',
        async () => (await import('./validate-required-type-suffix')).RequiredTypeSuffixValidator,
        RequiredTypeSuffixConfig.SCHEMA,
    ),
    new CodePolicy(
        FrameworkTsconfigConfig,
        'framework-tsconfig',
        async () => (await import('./validate-framework-tsconfig')).FrameworkTsconfigValidator,
        FrameworkTsconfigConfig.SCHEMA,
    ),
    new CodePolicy(
        FrameworkPackagesConfig,
        'framework-packages',
        async () => (await import('./validate-framework-packages')).FrameworkPackagesValidator,
        FrameworkPackagesConfig.SCHEMA,
    ),
];
