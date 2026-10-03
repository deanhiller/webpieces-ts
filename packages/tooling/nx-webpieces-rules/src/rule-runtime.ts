import {
    createProjectGraphAsync,
    readProjectsConfigurationFromProjectGraph,
    ExecutorContext,
    ProjectGraph,
    ProjectsConfigurations,
    NxJsonConfiguration,
} from '@nx/devkit';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    BaseRuleConfig,
    BuildPolicy,
    BuildPolicyResult,
    BuildRuleRuntime,
    PolicyRuntimeRequest,
} from '@webpieces/rules-sdk';
import { AbstractRule } from '@webpieces/rules-config';
import { RuleFailError } from '@webpieces/rules-config';
import { NX_POLICIES, NxPolicy } from './nx-policy-registry';
import { NativeAction, NativeActions } from './native-actions';

class NativeExecutorContext implements ExecutorContext {
    readonly cwd: string;
    readonly isVerbose = false;

    // eslint-disable-next-line @typescript-eslint/max-params
    constructor(
        readonly root: string,
        readonly projectGraph: ProjectGraph,
        readonly projectsConfigurations: ProjectsConfigurations,
        readonly nxJsonConfiguration: NxJsonConfiguration,
        readonly projectName: string | undefined,
    ) {
        this.cwd = root;
    }
}

/** Related policies share an existing native scan within this execution, including its failures. */
class NativeExecution {
    private readonly results = new Map<string, Promise<BuildPolicyResult>>();
    private graph: Promise<ProjectGraph> | undefined;

    constructor(private readonly root: string) {}

    run(action: NativeAction): Promise<BuildPolicyResult> {
        const existing = this.results.get(action.name);
        if (existing) return existing;
        const result = this.execute(action);
        this.results.set(action.name, result);
        return result;
    }

    private async execute(action: NativeAction): Promise<BuildPolicyResult> {
        const graph = await (this.graph ??= createProjectGraphAsync());
        const projects = readProjectsConfigurationFromProjectGraph(graph);
        const nxFile = path.join(this.root, 'nx.json');
        if (!fs.existsSync(nxFile))
            throw new RuleFailError(
                'policy-configuration',
                `Native Nx policies require ${nxFile}. Declare an Nx workspace or remove this pack.`,
            );
        const nxJson = JSON.parse(fs.readFileSync(nxFile, 'utf8')) as NxJsonConfiguration;
        const names =
            action.scope === 'workspace' ? [undefined] : Object.keys(projects.projects).sort();
        let success = true;
        for (const name of names) {
            const result = await action.execute(
                new NativeExecutorContext(this.root, graph, projects, nxJson, name),
            );
            if (!result || result.success !== true) success = false;
        }
        return new BuildPolicyResult(success);
    }
}

class NativeBuildPolicy extends AbstractRule<BaseRuleConfig> implements BuildPolicy {
    // eslint-disable-next-line @typescript-eslint/max-params
    constructor(
        config: BaseRuleConfig,
        id: string,
        private readonly action: NativeAction,
        private readonly execution: NativeExecution,
    ) {
        super(config, id, id);
    }

    run(_root: string): Promise<BuildPolicyResult> {
        return this.execution.run(this.action);
    }
}

export class NxRuleRuntime implements BuildRuleRuntime {
    async create(request: PolicyRuntimeRequest): Promise<readonly BuildPolicy[]> {
        const execution = new NativeExecution(request.workspaceRoot);
        return request.ruleIds.map((id: string) => {
            const config = request.configs[id];
            if (!config)
                throw new RuleFailError(
                    'policy-configuration',
                    `Missing explicit config for ${id}. Repair its declared owner file.`,
                );
            const policy = NX_POLICIES.find((entry: NxPolicy) => entry.definition.id === id);
            const action =
                id === 'validate-ts-in-src' ? new NativeActions().tsInSrc : policy?.action;
            if (!action)
                throw new RuleFailError(
                    'policy-configuration',
                    `Native Nx runtime has no implementation of ${id}. Repair its contribution.`,
                );
            return new NativeBuildPolicy(config as BaseRuleConfig, id, action, execution);
        });
    }
}

export const buildRuleRuntime = new NxRuleRuntime();
