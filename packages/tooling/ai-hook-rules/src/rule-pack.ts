import { optionalTuning, recommendedSeeds } from './rule-settings';
import { OwnedRuleDefinition, RuleContribution, RulePackManifest, RULE_PACK_API_VERSION, RULE_SCHEMA_API_VERSION } from '@webpieces/rules-sdk';
import { ThrowCauseRequiredConfig, NoJsFilesConfig, ValidateTsInSrcConfig } from './configs/rule-configs';
import { version } from '../package.json';

/** Source policies own their schema; other contributions consume their canonical owner's settings. */
const ownedRules = [
    new OwnedRuleDefinition('throw-cause-required', ThrowCauseRequiredConfig.SCHEMA, RULE_SCHEMA_API_VERSION, optionalTuning['throw-cause-required'], recommendedSeeds['throw-cause-required'], 'rules'),
    new OwnedRuleDefinition('no-js-files', NoJsFilesConfig.SCHEMA, RULE_SCHEMA_API_VERSION, optionalTuning['no-js-files'], recommendedSeeds['no-js-files'], 'rules'),
    new OwnedRuleDefinition('validate-ts-in-src', ValidateTsInSrcConfig.SCHEMA, RULE_SCHEMA_API_VERSION, optionalTuning['validate-ts-in-src'], recommendedSeeds['validate-ts-in-src'], 'rules'),
];

export const rulePackManifest = new RulePackManifest(
    '@webpieces/ai-hook-rules',
    version,
    RULE_PACK_API_VERSION,
    ownedRules,
    [
        ...ownedRules.map(rule => new RuleContribution(rule.id, '@webpieces/ai-hook-rules', 'source-hook')),
        new RuleContribution('no-any-unknown', '@webpieces/code-rules', 'source-hook'),
        new RuleContribution('no-implicit-any', '@webpieces/code-rules', 'source-hook'),
        new RuleContribution('max-file-lines', '@webpieces/code-rules', 'source-hook'),
        new RuleContribution('no-destructure', '@webpieces/code-rules', 'source-hook'),
        new RuleContribution('require-return-type', '@webpieces/code-rules', 'source-hook'),
        new RuleContribution('no-unmanaged-exceptions', '@webpieces/code-rules', 'source-hook'),
        new RuleContribution('catch-error-pattern', '@webpieces/code-rules', 'source-hook'),
        new RuleContribution('no-symbol-di-tokens', '@webpieces/code-rules', 'source-hook'),
        new RuleContribution('no-custom-css', '@webpieces/code-rules', 'source-hook'),
        new RuleContribution('no-process-exit-outside-main', '@webpieces/code-rules', 'source-hook'),
    ],
    [],
    [],
);
