import { RuleHelp } from '@webpieces/rules-sdk';

/** Owner-authored guidance consumed by the registry catalog. */
export const ruleHelp: Readonly<Record<string, RuleHelp>> = {
    'branch-creation-guard': new RuleHelp(
        'Create feature branches from the approved base and respect branch/worktree limits.',
        'Apply this policy in source, or review its explicit settings in {configFile}. An intentional opt-out requires complete OFF settings.',
    ),
    'pr-lifecycle-guard': new RuleHelp(
        'Use the reviewed PR flow and complete merge recovery through its prescribed commands.',
        'Apply this policy in source, or review its explicit settings in {configFile}. An intentional opt-out requires complete OFF settings.',
    ),
    'branch-state-guard': new RuleHelp(
        'Work in a current eligible feature tree and keep main synchronization explicit.',
        'Apply this policy in source, or review its explicit settings in {configFile}. An intentional opt-out requires complete OFF settings.',
    ),
};
