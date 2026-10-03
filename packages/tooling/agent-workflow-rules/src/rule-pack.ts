import { ruleMigrations } from './rule-migrations';
import { safeguardCatalog } from './safeguard-catalog';
import { optionalTuning, recommendedSeeds } from './rule-settings';
import { OwnedRuleDefinition, RuleContribution, RulePackManifest, RULE_PACK_API_VERSION, RULE_SCHEMA_API_VERSION } from '@webpieces/rules-sdk';
import { BranchCreationGuardConfig, PrLifecycleGuardConfig } from './configs/rule-configs';
import { BranchStateGuardConfig } from './configs/main-sync-guard-configs';
import { version } from '../package.json';

/** Workflow policies own their concrete configuration schema. */
const ownedRules = [
    new OwnedRuleDefinition('branch-creation-guard', BranchCreationGuardConfig.SCHEMA, RULE_SCHEMA_API_VERSION, optionalTuning['branch-creation-guard'], recommendedSeeds['branch-creation-guard'], 'hookGuards'),
    new OwnedRuleDefinition('pr-lifecycle-guard', PrLifecycleGuardConfig.SCHEMA, RULE_SCHEMA_API_VERSION, optionalTuning['pr-lifecycle-guard'], recommendedSeeds['pr-lifecycle-guard'], 'hookGuards'),
    new OwnedRuleDefinition('branch-state-guard', BranchStateGuardConfig.SCHEMA, RULE_SCHEMA_API_VERSION, optionalTuning['branch-state-guard'], recommendedSeeds['branch-state-guard'], 'hookGuards'),
];

export const rulePackManifest = new RulePackManifest(
    '@webpieces/agent-workflow-rules',
    version,
    RULE_PACK_API_VERSION,
    ownedRules,
    [
        ...ownedRules.map(rule => new RuleContribution(rule.id, '@webpieces/agent-workflow-rules', 'workflow-guard')),

    ],
    ruleMigrations,
    safeguardCatalog,
);
