import type { Rule } from 'eslint';
import { InformAiError } from '@webpieces/tooling-common';
import { BaseRuleConfig, PolicyRuntimeRequest } from '@webpieces/rules-sdk';
import { AbstractRule } from '@webpieces/rules-config';
import { LINT_POLICIES, LintPolicy } from './lint-policy-registry';
import * as implementations from './rules';

export class LintPlugin {
    constructor(readonly rules: Readonly<Record<string, Rule.RuleModule>>) {}
}

class LintActivation extends AbstractRule<BaseRuleConfig> {}

export class LintPolicyExecution {
    constructor(
        readonly ruleId: string,
        readonly severity: 'error' | 'off',
    ) {}
}

/** Activation follows explicit owner policy; client-authored ESLint implementation options remain in its ESLint config. */
export class LintRuleRuntime {
    plugin(): LintPlugin {
        const rules: Record<string, Rule.RuleModule> = {};
        for (const policy of LINT_POLICIES) {
            rules[policy.id] = (implementations as Record<string, Rule.RuleModule>)[
                policy.implementationExport
            ];
        }
        return new LintPlugin(rules);
    }

    create(request: PolicyRuntimeRequest): readonly LintPolicyExecution[] {
        return request.ruleIds.map((id: string) => {
            const policy = LINT_POLICIES.find((entry: LintPolicy) => entry.id === id);
            const config = request.configs[id];
            if (!policy || !config)
                throw new InformAiError(
                    `Missing declared lint contribution or explicit settings for ${id}.`,
                );
            const active = new LintActivation(config as BaseRuleConfig, id, id).shouldRun();
            return new LintPolicyExecution(id, active ? 'error' : 'off');
        });
    }
}

export const lintRuleRuntime = new LintRuleRuntime();
