import { RuleContribution, RulePackManifest, RULE_PACK_API_VERSION } from '@webpieces/rules-sdk';
import { ownedRules, SOURCE_POLICIES, SourcePolicy } from './source-policy-registry';
import { version } from '../package.json';

export const rulePackManifest = new RulePackManifest(
    '@webpieces/ai-hook-rules',
    version,
    RULE_PACK_API_VERSION,
    ownedRules,
    SOURCE_POLICIES.map(
        (policy: SourcePolicy) =>
            new RuleContribution(
                policy.id,
                policy.ownerPack,
                'source-hook',
                '@webpieces/ai-hook-rules/rule-runtime',
            ),
    ),
    [],
    [],
);
