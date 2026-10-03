import { RuleHelp } from '@webpieces/rules-sdk';

/** Owner-authored guidance consumed by the registry catalog. */
export const ruleHelp: Readonly<Record<string, RuleHelp>> = {
    'max-method-lines': new RuleHelp(
        'Limit method length in the configured scan scope.',
        'Apply this policy in source, or review its explicit settings in {configFile}. An intentional opt-out requires complete OFF settings.',
    ),
    'max-file-lines': new RuleHelp(
        'Limit source file length in the configured scan scope.',
        'Apply this policy in source, or review its explicit settings in {configFile}. An intentional opt-out requires complete OFF settings.',
    ),
    'require-return-type': new RuleHelp(
        'Require explicit function and method return types.',
        'Apply this policy in source, or review its explicit settings in {configFile}. An intentional opt-out requires complete OFF settings.',
    ),
    'no-inline-type-literals': new RuleHelp(
        'Use named data classes instead of inline object type declarations.',
        'Apply this policy in source, or review its explicit settings in {configFile}. An intentional opt-out requires complete OFF settings.',
    ),
    'no-any-unknown': new RuleHelp(
        'Reject both any and unknown keyword types; use the actual concrete data type. Catch-variable annotations retain their specific exception.',
        'Understand the data contract and reuse its concrete type or define a precise class, interface or type. Do not replace any with unknown or hide it behind a cast. Review explicit settings in {configFile} only for an intentional policy change.',
    ),
    'no-implicit-any': new RuleHelp(
        'Require explicit parameter types when inference does not establish them.',
        'Apply this policy in source, or review its explicit settings in {configFile}. An intentional opt-out requires complete OFF settings.',
    ),
    'prisma-validate-dtos': new RuleHelp(
        'Validate Prisma-facing DTO declarations against the generated model.',
        'Apply this policy in source, or review its explicit settings in {configFile}. An intentional opt-out requires complete OFF settings.',
    ),
    'prisma-converter': new RuleHelp(
        'Validate the converters between Prisma models and application DTOs.',
        'Apply this policy in source, or review its explicit settings in {configFile}. An intentional opt-out requires complete OFF settings.',
    ),
    'no-destructure': new RuleHelp(
        'Use whole values or explicit property access instead of destructuring.',
        'Apply this policy in source, or review its explicit settings in {configFile}. An intentional opt-out requires complete OFF settings.',
    ),
    'catch-error-pattern': new RuleHelp(
        'Narrow caught errors through the shared error conversion pattern.',
        'Apply this policy in source, or review its explicit settings in {configFile}. An intentional opt-out requires complete OFF settings.',
    ),
    'no-unmanaged-exceptions': new RuleHelp(
        'Handle or explicitly document exceptions at the responsible boundary.',
        'Apply this policy in source, or review its explicit settings in {configFile}. An intentional opt-out requires complete OFF settings.',
    ),
    'angular-no-direct-api-in-resolver': new RuleHelp(
        'Keep direct API client construction out of Angular resolvers.',
        'Apply this policy in source, or review its explicit settings in {configFile}. An intentional opt-out requires complete OFF settings.',
    ),
    'no-symbol-di-tokens': new RuleHelp(
        'Use class tokens for dependency injection instead of symbol tokens.',
        'Apply this policy in source, or review its explicit settings in {configFile}. An intentional opt-out requires complete OFF settings.',
    ),
    'no-client-creation-outside-server-or-client': new RuleHelp(
        'Construct API clients only in their designated server or client layer.',
        'Apply this policy in source, or review its explicit settings in {configFile}. An intentional opt-out requires complete OFF settings.',
    ),
    'no-custom-css': new RuleHelp(
        'Use the configured styling system instead of custom CSS in governed files.',
        'Apply this policy in source, or review its explicit settings in {configFile}. An intentional opt-out requires complete OFF settings.',
    ),
    'no-state-paths-in-templates': new RuleHelp(
        'Use the declared state binding pattern in application templates.',
        'Apply this policy in source, or review its explicit settings in {configFile}. An intentional opt-out requires complete OFF settings.',
    ),
    'no-process-exit-outside-main': new RuleHelp(
        'Restrict process termination to executable application boundaries.',
        'Apply this policy in source, or review its explicit settings in {configFile}. An intentional opt-out requires complete OFF settings.',
    ),
    'no-function-outside-class': new RuleHelp(
        'Put business operations in instance methods on classes.',
        'Apply this policy in source, or review its explicit settings in {configFile}. An intentional opt-out requires complete OFF settings.',
    ),
    'inject-annotation-not-needed-for-concrete-class': new RuleHelp(
        'Inject concrete classes by their class token without redundant annotations.',
        'Apply this policy in source, or review its explicit settings in {configFile}. An intentional opt-out requires complete OFF settings.',
    ),
    'framework-tag': new RuleHelp(
        'Match project framework tags to their actual code and package usage.',
        'Apply this policy in source, or review its explicit settings in {configFile}. An intentional opt-out requires complete OFF settings.',
    ),
    'role-tag': new RuleHelp(
        'Match project role tags to their actual API and implementation responsibilities.',
        'Apply this policy in source, or review its explicit settings in {configFile}. An intentional opt-out requires complete OFF settings.',
    ),
    'ensure-we-are-secure': new RuleHelp(
        'Check configured API security requirements at the implementation boundary.',
        'Apply this policy in source, or review its explicit settings in {configFile}. An intentional opt-out requires complete OFF settings.',
    ),
    'no-inline-import-in-api-lib': new RuleHelp(
        'Keep API library type imports explicit and named.',
        'Apply this policy in source, or review its explicit settings in {configFile}. An intentional opt-out requires complete OFF settings.',
    ),
    'one-enum-spelling-in-api-lib': new RuleHelp(
        'Use one enum declaration spelling in API libraries.',
        'Apply this policy in source, or review its explicit settings in {configFile}. An intentional opt-out requires complete OFF settings.',
    ),
    'no-utility-types-in-api-lib': new RuleHelp(
        'Use explicit named API data contracts instead of utility types.',
        'Apply this policy in source, or review its explicit settings in {configFile}. An intentional opt-out requires complete OFF settings.',
    ),
    'required-type-suffix': new RuleHelp(
        'Require configured suffixes on API contract types.',
        'Apply this policy in source, or review its explicit settings in {configFile}. An intentional opt-out requires complete OFF settings.',
    ),
    'framework-tsconfig': new RuleHelp(
        'Align framework-specific TypeScript settings with project declarations.',
        'Apply this policy in source, or review its explicit settings in {configFile}. An intentional opt-out requires complete OFF settings.',
    ),
    'framework-packages': new RuleHelp(
        'Align framework packages with the configured project requirements.',
        'Apply this policy in source, or review its explicit settings in {configFile}. An intentional opt-out requires complete OFF settings.',
    ),
};
