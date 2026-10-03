import 'reflect-metadata';
import { Container } from 'inversify';
import {
    BuildPolicy,
    BuildRuleRuntime,
    PolicyRuntimeRequest,
    BuildDebugRequest,
    BuildDebugRuntime,
    BuildPolicyResult,
} from '@webpieces/rules-sdk';
import { InformAiError } from '@webpieces/tooling-common';
import { CODE_POLICIES, CodePolicy } from './code-policy-registry';
import { WorkspaceRoot } from './code-rules-context';
import { ScanRestriction } from './scan-scope';
import { BuildPolicySet } from './code-rules-engine';

/** Composition stays with the code owner; the public manifest never imports validators. */
export class CodeRuleRuntime implements BuildRuleRuntime {
    async create(request: PolicyRuntimeRequest): Promise<readonly BuildPolicy[]> {
        return (await this.compose(request, undefined)).get(BuildPolicySet).policies;
    }

    async compose(
        request: PolicyRuntimeRequest,
        projects: readonly string[] | undefined,
    ): Promise<Container> {
        const container = new Container({ autobind: true });
        container.bind(WorkspaceRoot).toConstantValue(new WorkspaceRoot(request.workspaceRoot));
        container.bind(ScanRestriction).toConstantValue(new ScanRestriction(projects));
        const policies = request.ruleIds.map((id: string) => this.entry(id));
        for (const policy of policies) {
            const config = request.configs[policy.ruleId];
            if (!config)
                throw new InformAiError(
                    `Missing explicit config for ${policy.ruleId}. Repair its declared owner file.`,
                );
            container.bind(policy.configClass).toConstantValue(config);
        }
        const checks = await Promise.all(
            policies.map(async (policy: CodePolicy) => container.get(await policy.loadValidator())),
        );
        container.bind(BuildPolicySet).toConstantValue(new BuildPolicySet(checks));
        return container;
    }

    private entry(id: string): CodePolicy {
        const entry = CODE_POLICIES.find((policy: CodePolicy) => policy.ruleId === id);
        if (!entry)
            throw new InformAiError(
                `Code runtime has no implementation of ${id}. Repair the owner's contribution.`,
            );
        return entry;
    }
}

