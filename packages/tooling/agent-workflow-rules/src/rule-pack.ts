import { OwnedRuleDefinition, RuleContribution, RulePackManifest, RULE_PACK_API_VERSION, RULE_SCHEMA_API_VERSION } from '@webpieces/rules-sdk';
import { RULE_SCHEMAS } from '@webpieces/rules-config';
import { version } from '../package.json';

/** Compatibility manifest; executable registries remain authoritative until ownership migration. */
const ownedRuleIds = [
    "branch-creation-guard",
    "pr-lifecycle-guard",
    "branch-state-guard"
] as const;

export const rulePackManifest = new RulePackManifest(
    '@webpieces/agent-workflow-rules',
    version,
    RULE_PACK_API_VERSION,
    ownedRuleIds.map(id => new OwnedRuleDefinition(id, RULE_SCHEMAS[id], RULE_SCHEMA_API_VERSION)),
    [
        ...ownedRuleIds.map(id => new RuleContribution(id, '@webpieces/agent-workflow-rules', 'workflow-guard')),

    ],
);
