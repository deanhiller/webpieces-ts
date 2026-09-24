import { Container } from 'inversify';
import {
    BaseRuleConfig,
    LoadedConfig,
    MatchRuleConfig,
    MODIFIED_CODE_MODES,
    ProjectIndex,
    schemaModeValues,
} from '@webpieces/rules-config';

import { CodeRulesRunRequest } from './code-rules-run-request';
import { WorkspaceRoot, MatchRulesHolder } from './code-rules-context';
import { CONFIG_BINDINGS } from './code-rules-config-table';
import { RuleScopePlanner, RuleScopes } from './rule-scope-plan';

/**
 * The ONE code-rules composition root, shared by the `wp-validate-code` bin (cli.ts) and the nx
 * `validate-code` executor (validate-code.ts) so the two entry points cannot drift: bind the workspace
 * root, the run request, each rule's config AS PLANNED (whole-scope modes applied, a debug run's
 * `--mode` applied — see {@link RuleScopePlanner}) and the resulting {@link RuleScopes}. The caller then
 * resolves `CodeRulesApp`, and inversify builds the entire validator DAG.
 */
export class CodeRulesBootstrap {
    container(workspaceRoot: string, loaded: LoadedConfig, request: CodeRulesRunRequest): Container {
        const roots = request.projects === null ? null : new ProjectIndex(workspaceRoot).rootsFor(request.projects);
        const planner = new RuleScopePlanner(request, roots);

        // autobind self-binds every @injectable(Singleton) tooling class (replaces the buildProviderModule registry scan)
        const container = new Container({ autobind: true });
        container.bind(WorkspaceRoot).toConstantValue(new WorkspaceRoot(workspaceRoot));
        container.bind(CodeRulesRunRequest).toConstantValue(request);
        for (const binding of CONFIG_BINDINGS) {
            const ConfigClass = binding[0];
            const configured = (loaded.rulesConfig[binding[1]] as BaseRuleConfig | undefined) ?? new ConfigClass();
            const planned = planner.plan(binding[1], configured, schemaModeValues(binding[1]) ?? []);
            container.bind(ConfigClass).toConstantValue(planned);
        }
        const matchRules = loaded.matchRules.map((mr: MatchRuleConfig) => planner.plan(mr.name, mr, MODIFIED_CODE_MODES));
        container.bind(MatchRulesHolder).toConstantValue(new MatchRulesHolder(matchRules));
        container.bind(RuleScopes).toConstantValue(planner.result());
        return container;
    }
}
