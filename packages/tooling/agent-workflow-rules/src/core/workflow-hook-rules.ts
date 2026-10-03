import { LoadedConfig } from '@webpieces/rules-config';
import { HookRuleSet, HookPolicyContributions } from '@webpieces/hook-runtime';
import { WorkflowRuleRuntime } from '../rule-runtime';

export class WorkflowHookRules {
    load(loaded: LoadedConfig): HookRuleSet {
        const rules = new HookPolicyContributions(
            new Map([['@webpieces/agent-workflow-rules/rule-runtime', new WorkflowRuleRuntime()]]),
        ).load(loaded, 'workflow-guard');
        return new HookRuleSet(rules);
    }
}
