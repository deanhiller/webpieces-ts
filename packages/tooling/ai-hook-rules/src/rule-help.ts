import { RuleHelp } from '@webpieces/rules-sdk';

/** Owner-authored guidance consumed by the registry catalog. */
export const ruleHelp: Readonly<Record<string, RuleHelp>> = {
    'throw-cause-required': new RuleHelp(
        'Preserve the original error as cause when throwing a replacement error.',
        'Apply this policy in source, or review its explicit settings in {configFile}. An intentional opt-out requires complete OFF settings.',
    ),
    'no-js-files': new RuleHelp(
        'Keep governed source in TypeScript rather than JavaScript.',
        'Apply this policy in source, or review its explicit settings in {configFile}. An intentional opt-out requires complete OFF settings.',
    ),
    'validate-ts-in-src': new RuleHelp(
        'Keep TypeScript implementation files inside their project source directory.',
        'Apply this policy in source, or review its explicit settings in {configFile}. An intentional opt-out requires complete OFF settings.',
    ),
};
