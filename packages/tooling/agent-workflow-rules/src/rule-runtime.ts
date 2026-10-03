import { HookPolicyRuntimeRequest, HookRuleRuntime, Rule } from '@webpieces/hook-runtime';
import { InformAiError } from '@webpieces/tooling-common';
import {
    WORKFLOW_POLICIES,
    WorkflowPolicy,
    WorkflowImplementation,
} from './workflow-policy-registry';
import * as implementations from './core/rules';

type WorkflowRuleCtor = new (...args: never[]) => Rule;

export class WorkflowRuleRuntime implements HookRuleRuntime {
    create(request: HookPolicyRuntimeRequest): readonly Rule[] {
        return request.ruleIds.flatMap((id: string) => {
            const policy = WORKFLOW_POLICIES.find(
                (entry: WorkflowPolicy) => entry.definition.id === id,
            );
            if (!policy)
                throw new InformAiError(
                    `Workflow runtime has no implementation of ${id}. Repair its contribution.`,
                );
            const config = request.configs[id];
            if (!config)
                throw new InformAiError(
                    `Missing explicit config for ${id}. Repair its declared owner file.`,
                );
            return policy.implementations.map((entry: WorkflowImplementation) => {
                const ctor = (implementations as Record<string, WorkflowRuleCtor>)[
                    entry.exportName
                ];
                if (!ctor)
                    throw new InformAiError(
                        `Missing workflow implementation ${entry.exportName}. Repair its runtime export.`,
                    );
                const command =
                    entry.commandHint === null ? undefined : request.commands[entry.commandHint];
                return Reflect.construct(ctor, [config, command]) as Rule;
            });
        });
    }
}

export const workflowRuleRuntime = new WorkflowRuleRuntime();
