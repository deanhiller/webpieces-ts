import { OwnedRuleDefinition, RULE_SCHEMA_API_VERSION } from '@webpieces/rules-sdk';
import { BranchCreationGuardConfig, PrLifecycleGuardConfig } from './configs/rule-configs';
import { BranchStateGuardConfig } from './configs/main-sync-guard-configs';
import { optionalTuning, recommendedSeeds } from './rule-settings';
import { ruleHelp } from './rule-help';

export class WorkflowImplementation {
    constructor(
        readonly exportName: string,
        readonly commandHint: 'upsertPr' | 'mergeComplete' | null,
    ) {}
}

export class WorkflowPolicy {
    constructor(
        readonly definition: OwnedRuleDefinition,
        readonly implementations: readonly WorkflowImplementation[],
    ) {}
}

export const WORKFLOW_POLICIES: readonly WorkflowPolicy[] = [
    new WorkflowPolicy(
        new OwnedRuleDefinition(
            'branch-creation-guard',
            BranchCreationGuardConfig.SCHEMA,
            RULE_SCHEMA_API_VERSION,
            optionalTuning['branch-creation-guard'],
            recommendedSeeds['branch-creation-guard'],
            'hookGuards',
            ruleHelp['branch-creation-guard'],
        ),
        [new WorkflowImplementation('BranchCreationGuardRule', null)],
    ),
    new WorkflowPolicy(
        new OwnedRuleDefinition(
            'pr-lifecycle-guard',
            PrLifecycleGuardConfig.SCHEMA,
            RULE_SCHEMA_API_VERSION,
            optionalTuning['pr-lifecycle-guard'],
            recommendedSeeds['pr-lifecycle-guard'],
            'hookGuards',
            ruleHelp['pr-lifecycle-guard'],
        ),
        [
            new WorkflowImplementation('PrCreationOrPushGuardRule', 'upsertPr'),
            new WorkflowImplementation('MergeInProgressGuardRule', 'mergeComplete'),
            new WorkflowImplementation('PrMergeGuardRule', null),
            new WorkflowImplementation('RedirectHowToMergeMainRule', null),
        ],
    ),
    new WorkflowPolicy(
        new OwnedRuleDefinition(
            'branch-state-guard',
            BranchStateGuardConfig.SCHEMA,
            RULE_SCHEMA_API_VERSION,
            optionalTuning['branch-state-guard'],
            recommendedSeeds['branch-state-guard'],
            'hookGuards',
            ruleHelp['branch-state-guard'],
        ),
        [
            new WorkflowImplementation('FeatureBranchGuardRule', null),
            new WorkflowImplementation('ReadStaleGuardRule', null),
            new WorkflowImplementation('MergedBranchBashGuardRule', null),
            new WorkflowImplementation('StaleMainBashGuardRule', null),
        ],
    ),
];
