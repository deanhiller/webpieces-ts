import { RuleContribution, RulePackManifest, RULE_PACK_API_VERSION } from '@webpieces/rules-sdk';
import { LINT_POLICIES, ownedRules, LintPolicy } from './lint-policy-registry';
import { version } from '../package.json';

export const rulePackManifest = new RulePackManifest(
    '@webpieces/eslint-rules',
    version,
    RULE_PACK_API_VERSION,
    ownedRules,
    LINT_POLICIES.map(
        (policy: LintPolicy) =>
            new RuleContribution(
                policy.id,
                policy.ownerPack,
                'lint',
                '@webpieces/eslint-rules/rule-runtime',
            ),
    ),
    [],
    [],
);
