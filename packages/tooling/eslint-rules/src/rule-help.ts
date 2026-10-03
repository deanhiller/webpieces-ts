import { RuleHelp } from '@webpieces/rules-sdk';

/** Owner-authored guidance consumed by the registry catalog. */
export const ruleHelp: Readonly<Record<string, RuleHelp>> = {
    'enforce-architecture': new RuleHelp(
        'Respect declared architecture boundaries in linted imports.',
        'Apply this policy in source, or review its explicit settings in {configFile}. An intentional opt-out requires complete OFF settings.',
    ),
    'no-json-property-primitive-type': new RuleHelp(
        'Use the prescribed JSON property typing convention.',
        'Apply this policy in source, or review its explicit settings in {configFile}. An intentional opt-out requires complete OFF settings.',
    ),
    'require-typed-template': new RuleHelp(
        'Use typed template declarations in governed Angular code.',
        'Apply this policy in source, or review its explicit settings in {configFile}. An intentional opt-out requires complete OFF settings.',
    ),
    'no-mat-cell-def': new RuleHelp(
        'Use the governed table-cell template pattern instead of matCellDef.',
        'Apply this policy in source, or review its explicit settings in {configFile}. An intentional opt-out requires complete OFF settings.',
    ),
};
