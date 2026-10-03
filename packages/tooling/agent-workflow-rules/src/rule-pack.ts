import { RuleContribution, RulePackManifest, RULE_PACK_API_VERSION } from '@webpieces/rules-sdk';
import { ruleMigrations } from './rule-migrations';
import { safeguardCatalog } from './safeguard-catalog';
import { WORKFLOW_POLICIES, WorkflowPolicy } from './workflow-policy-registry';
import { version } from '../package.json';

export const rulePackManifest = new RulePackManifest(
    '@webpieces/agent-workflow-rules',
    version,
    RULE_PACK_API_VERSION,
    WORKFLOW_POLICIES.map((policy: WorkflowPolicy) => policy.definition),
    WORKFLOW_POLICIES.map(
        (policy: WorkflowPolicy) =>
            new RuleContribution(
                policy.definition.id,
                '@webpieces/agent-workflow-rules',
                'workflow-guard',
                '@webpieces/agent-workflow-rules/rule-runtime',
            ),
    ),
    ruleMigrations,
    safeguardCatalog,
);
