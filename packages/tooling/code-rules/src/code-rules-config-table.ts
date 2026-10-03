import { BaseRuleConfig, FieldDef } from '@webpieces/rules-sdk';
import { MaxMethodLinesConfig, MaxFileLinesConfig, RequireReturnTypeConfig, NoInlineTypeLiteralsConfig, NoAnyUnknownConfig, NoImplicitAnyConfig, PrismaValidateDtosConfig, PrismaConverterConfig, NoDestructureConfig, CatchErrorPatternConfig, NoUnmanagedExceptionsConfig, AngularNoDirectApiInResolverConfig, NoSymbolDiTokensConfig, NoCustomCssConfig, NoProcessExitOutsideMainConfig, NoFunctionOutsideClassConfig, InjectAnnotationNotNeededForConcreteClassConfig, FrameworkTagConfig, RoleTagConfig, EnsureWeAreSecureConfig } from "./configs/rule-configs";
import { NoClientCreationOutsideServerOrClientConfig } from "./configs/no-client-creation-config";
import { NoStatePathsInTemplatesConfig } from "./configs/no-state-paths-config";
import { NoInlineImportInApiLibConfig, OneEnumSpellingInApiLibConfig } from "./configs/api-lib-spelling-configs";
import { NoUtilityTypesInApiLibConfig } from "./configs/no-utility-types-config";
import { RequiredTypeSuffixConfig } from "./configs/required-type-suffix-config";
import { FrameworkTsconfigConfig, FrameworkPackagesConfig } from "./configs/tag-truth-configs";

/** A concrete configuration data constructor used as the owner DI token. */
export type ConfigCtor = new () => BaseRuleConfig;

/** An owner-local configuration binding and its canonical schema. */
export class ConfigBinding {
    constructor(
        readonly configClass: ConfigCtor,
        readonly ruleId: string,
        readonly schema: Readonly<Record<string, FieldDef>>,
    ) {}
}

export const CONFIG_BINDINGS: ReadonlyArray<ConfigBinding> = [
    new ConfigBinding(MaxMethodLinesConfig, 'max-method-lines', MaxMethodLinesConfig.SCHEMA),
    new ConfigBinding(MaxFileLinesConfig, 'max-file-lines', MaxFileLinesConfig.SCHEMA),
    new ConfigBinding(RequireReturnTypeConfig, 'require-return-type', RequireReturnTypeConfig.SCHEMA),
    new ConfigBinding(NoInlineTypeLiteralsConfig, 'no-inline-type-literals', NoInlineTypeLiteralsConfig.SCHEMA),
    new ConfigBinding(NoAnyUnknownConfig, 'no-any-unknown', NoAnyUnknownConfig.SCHEMA),
    new ConfigBinding(NoImplicitAnyConfig, 'no-implicit-any', NoImplicitAnyConfig.SCHEMA),
    new ConfigBinding(PrismaValidateDtosConfig, 'prisma-validate-dtos', PrismaValidateDtosConfig.SCHEMA),
    new ConfigBinding(PrismaConverterConfig, 'prisma-converter', PrismaConverterConfig.SCHEMA),
    new ConfigBinding(NoDestructureConfig, 'no-destructure', NoDestructureConfig.SCHEMA),
    new ConfigBinding(CatchErrorPatternConfig, 'catch-error-pattern', CatchErrorPatternConfig.SCHEMA),
    new ConfigBinding(NoUnmanagedExceptionsConfig, 'no-unmanaged-exceptions', NoUnmanagedExceptionsConfig.SCHEMA),
    new ConfigBinding(AngularNoDirectApiInResolverConfig, 'angular-no-direct-api-in-resolver', AngularNoDirectApiInResolverConfig.SCHEMA),
    new ConfigBinding(NoSymbolDiTokensConfig, 'no-symbol-di-tokens', NoSymbolDiTokensConfig.SCHEMA),
    new ConfigBinding(NoClientCreationOutsideServerOrClientConfig, 'no-client-creation-outside-server-or-client', NoClientCreationOutsideServerOrClientConfig.SCHEMA),
    new ConfigBinding(NoCustomCssConfig, 'no-custom-css', NoCustomCssConfig.SCHEMA),
    new ConfigBinding(NoStatePathsInTemplatesConfig, 'no-state-paths-in-templates', NoStatePathsInTemplatesConfig.SCHEMA),
    new ConfigBinding(NoProcessExitOutsideMainConfig, 'no-process-exit-outside-main', NoProcessExitOutsideMainConfig.SCHEMA),
    new ConfigBinding(NoFunctionOutsideClassConfig, 'no-function-outside-class', NoFunctionOutsideClassConfig.SCHEMA),
    new ConfigBinding(InjectAnnotationNotNeededForConcreteClassConfig, 'inject-annotation-not-needed-for-concrete-class', InjectAnnotationNotNeededForConcreteClassConfig.SCHEMA),
    new ConfigBinding(FrameworkTagConfig, 'framework-tag', FrameworkTagConfig.SCHEMA),
    new ConfigBinding(RoleTagConfig, 'role-tag', RoleTagConfig.SCHEMA),
    new ConfigBinding(EnsureWeAreSecureConfig, 'ensure-we-are-secure', EnsureWeAreSecureConfig.SCHEMA),
    new ConfigBinding(NoInlineImportInApiLibConfig, 'no-inline-import-in-api-lib', NoInlineImportInApiLibConfig.SCHEMA),
    new ConfigBinding(OneEnumSpellingInApiLibConfig, 'one-enum-spelling-in-api-lib', OneEnumSpellingInApiLibConfig.SCHEMA),
    new ConfigBinding(NoUtilityTypesInApiLibConfig, 'no-utility-types-in-api-lib', NoUtilityTypesInApiLibConfig.SCHEMA),
    new ConfigBinding(RequiredTypeSuffixConfig, 'required-type-suffix', RequiredTypeSuffixConfig.SCHEMA),
    new ConfigBinding(FrameworkTsconfigConfig, 'framework-tsconfig', FrameworkTsconfigConfig.SCHEMA),
    new ConfigBinding(FrameworkPackagesConfig, 'framework-packages', FrameworkPackagesConfig.SCHEMA),
];
