import { ruleHelp } from './rule-help';
import { optionalTuning, recommendedSeeds } from './rule-settings';
import {
    OwnedRuleDefinition,
    RuleContribution,
    RulePackManifest,
    RULE_PACK_API_VERSION,
    RULE_SCHEMA_API_VERSION,
} from '@webpieces/rules-sdk';
import { CODE_POLICIES, CodePolicy } from './code-policy-registry';
import { version } from '../package.json';

/** The code owner publishes the same definitions its composition root binds. */
export const rulePackManifest = new RulePackManifest(
    '@webpieces/code-rules',
    version,
    RULE_PACK_API_VERSION,
    CODE_POLICIES.map(
        (binding: CodePolicy) =>
            new OwnedRuleDefinition(
                binding.ruleId,
                binding.schema,
                RULE_SCHEMA_API_VERSION,
                optionalTuning[binding.ruleId],
                recommendedSeeds[binding.ruleId],
                'rules',
                ruleHelp[binding.ruleId],
            ),
    ),
    CODE_POLICIES.map(
        (binding: CodePolicy) =>
            new RuleContribution(
                binding.ruleId,
                '@webpieces/code-rules',
                'build',
                '@webpieces/code-rules/rule-runtime',
            ),
    ),
    [],
    [],
);
