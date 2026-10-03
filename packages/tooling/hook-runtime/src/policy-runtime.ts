import { PolicyRuntimeRequest } from '@webpieces/rules-sdk';
import { CommandsConfig } from '@webpieces/rules-config';
import { Rule } from './core/types';

/** Hook mechanics receive the resolved generic command configuration separately from owner settings. */
export class HookPolicyRuntimeRequest extends PolicyRuntimeRequest {
    constructor(
        request: PolicyRuntimeRequest,
        readonly commands: CommandsConfig,
    ) {
        super(request.workspaceRoot, request.configs, request.ruleIds);
    }
}

export interface HookRuleRuntime {
    create(request: HookPolicyRuntimeRequest): readonly Rule[];
}
