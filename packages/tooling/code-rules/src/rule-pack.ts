import { optionalTuning, recommendedSeeds } from './rule-settings';
import { OwnedRuleDefinition, RuleContribution, RulePackManifest, RULE_PACK_API_VERSION, RULE_SCHEMA_API_VERSION } from '@webpieces/rules-sdk';
import { CONFIG_BINDINGS } from './code-rules-config-table';
import { version } from '../package.json';

/** The code owner publishes the same definitions its composition root binds. */
export const rulePackManifest = new RulePackManifest(
    '@webpieces/code-rules',
    version,
    RULE_PACK_API_VERSION,
    CONFIG_BINDINGS.map(binding => new OwnedRuleDefinition(binding.ruleId, binding.schema, RULE_SCHEMA_API_VERSION, optionalTuning[binding.ruleId], recommendedSeeds[binding.ruleId], 'rules')),
    CONFIG_BINDINGS.map(binding => new RuleContribution(binding.ruleId, '@webpieces/code-rules', 'build')),
    [],
    [],
);
