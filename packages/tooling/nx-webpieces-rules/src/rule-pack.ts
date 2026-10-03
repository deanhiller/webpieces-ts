import { RuleContribution, RulePackManifest, RULE_PACK_API_VERSION } from '@webpieces/rules-sdk';
import { ruleMigrations } from './rule-migrations';
import { NX_POLICIES, NxPolicy } from './nx-policy-registry';
import { version } from '../package.json';

export const rulePackManifest = new RulePackManifest(
    '@webpieces/nx-webpieces-rules',
    version,
    RULE_PACK_API_VERSION,
    NX_POLICIES.map((policy: NxPolicy) => policy.definition),
    [
        ...NX_POLICIES.map(
            (policy: NxPolicy) =>
                new RuleContribution(
                    policy.definition.id,
                    '@webpieces/nx-webpieces-rules',
                    'build',
                    '@webpieces/nx-webpieces-rules/rule-runtime',
                ),
        ),
        new RuleContribution(
            'validate-ts-in-src',
            '@webpieces/ai-hook-rules',
            'build',
            '@webpieces/nx-webpieces-rules/rule-runtime',
        ),
    ],
    ruleMigrations,
    [],
);
