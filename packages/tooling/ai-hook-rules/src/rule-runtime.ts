import { BaseRuleConfig, PolicyRuntimeRequest } from '@webpieces/rules-sdk';
import { Rule } from '@webpieces/hook-runtime';
import { InformAiError } from '@webpieces/tooling-common';
import { SOURCE_POLICIES, SourcePolicy } from './source-policy-registry';
import * as implementations from './core/rules';

type SourceRuleCtor = new (config: BaseRuleConfig) => Rule;

/** Runtime imports are isolated from the public metadata module. */
export class SourceRuleRuntime {
    create(request: PolicyRuntimeRequest): readonly Rule[] {
        return request.ruleIds.map((id: string) => {
            const policy = SOURCE_POLICIES.find((entry: SourcePolicy) => entry.id === id);
            if (!policy)
                throw new InformAiError(
                    `Source runtime has no implementation of ${id}. Repair its contribution.`,
                );
            const config = request.configs[id];
            if (!config)
                throw new InformAiError(
                    `Missing explicit config for ${id}. Repair its declared owner file.`,
                );
            const ctor = (implementations as Record<string, SourceRuleCtor>)[
                policy.implementationExport
            ];
            if (!ctor)
                throw new InformAiError(
                    `Missing source implementation ${policy.implementationExport}. Repair its runtime export.`,
                );
            return new ctor(config as BaseRuleConfig);
        });
    }
}

export const sourceRuleRuntime = new SourceRuleRuntime();
