import * as path from 'node:path';
import { createRequire } from 'node:module';
import {
    BuildPolicy,
    BuildRuleRuntime,
    BuildDebugRequest,
    BuildDebugRuntime,
    BuildPolicyResult,
    ConfigObject,
    ExecutionKind,
    PolicyRuntimeRequest,
} from '@webpieces/rules-sdk';
import { InformAiError } from '@webpieces/tooling-common';
import { RulePackRegistry } from './rule-pack-registry';
import { ClientModuleResolution } from './client-module-resolution';
import { toError } from '@webpieces/tooling-common/to-error';

/** Describes an implementation without evaluating its module during config validation. */
export class RuntimeContributionGroup {
    constructor(
        readonly providerPack: string,
        readonly implementationModule: string,
        readonly executionKind: ExecutionKind,
        readonly ruleIds: readonly string[],
    ) {}
}

export abstract class RuleRuntimeModuleLoader {
    // webpieces-disable no-any-unknown -- execution-family consumers validate external module contracts
    abstract load(moduleName: string, providerModule: string): unknown;
}

export class NodeRuleRuntimeModuleLoader extends RuleRuntimeModuleLoader {
    private readonly resolution: ClientModuleResolution;
    private readonly requireModule: NodeRequire;

    constructor(clientRoot: string) {
        super();
        this.resolution = new ClientModuleResolution(clientRoot);
        this.requireModule = createRequire(path.join(clientRoot, 'package.json'));
    }

    // webpieces-disable no-any-unknown -- narrowed by its execution-family consumer
    override load(moduleName: string, providerModule: string): unknown {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- a declared module fault names the runtime and declaration needed for repair
        try {
            const resolved =
                moduleName.startsWith('.') || path.isAbsolute(moduleName)
                    ? path.resolve(
                          path.dirname(this.resolution.resolve(providerModule)),
                          moduleName,
                      )
                    : this.resolution.resolve(moduleName);
            return this.requireModule(resolved);
        // webpieces-disable no-any-unknown -- external JSON or runtime exports are validated before policy execution
        } catch (err: unknown) {
            const error = toError(err);
            throw new InformAiError(
                `Cannot load declared policy runtime ${moduleName} from ${providerModule}: ${error.message}. Repair its public implementation module or root declaration.`,
                { cause: error },
            );
        }
    }
}

/** Grouped module loading has no built-in package list or policy IDs. */
export class RuleRuntimeModules {
    // webpieces-disable no-any-unknown -- a selected provider explicitly advertises its debug capability
    async runBuildDebug(exports: unknown, request: BuildDebugRequest): Promise<BuildPolicyResult> {
        if (!exports || typeof exports !== 'object' || !('buildDebugRuntime' in exports)) {
            throw new InformAiError(
                `The build provider for ${request.selection.rule} does not support debug runs. Use its declared policy settings and normal validation.`,
            );
        }
        const runtime = exports.buildDebugRuntime as BuildDebugRuntime;
        if (!runtime || typeof runtime.run !== 'function')
            throw new InformAiError(
                'Invalid buildDebugRuntime.run(request). Repair the provider export.',
            );
        const result = await runtime.run(request);
        if (!result || typeof result.success !== 'boolean')
            throw new InformAiError('Debug runtime must return an explicit success boolean.');
        return result;
    }

    groups(registry: RulePackRegistry, kind: ExecutionKind): readonly RuntimeContributionGroup[] {
        const groups: RuntimeContributionGroup[] = [];
        for (const manifest of registry.manifests) {
            const modules = new Map<string, string[]>();
            for (const contribution of manifest.contributions) {
                if (contribution.executionKind !== kind) continue;
                const ids = modules.get(contribution.implementationModule) ?? [];
                ids.push(contribution.ruleId);
                modules.set(contribution.implementationModule, ids);
            }
            for (const entry of modules) {
                const moduleName = entry[0], ids = entry[1];
                groups.push(
                    new RuntimeContributionGroup(manifest.packageName, moduleName, kind, ids),
                );
            }
        }
        return groups;
    }

    // webpieces-disable no-any-unknown -- transport boundary for execution-family adapters
    load(
        group: RuntimeContributionGroup,
        providers: ReadonlyMap<string, string>,
        loader: RuleRuntimeModuleLoader,
    // webpieces-disable no-any-unknown -- external JSON or runtime exports are validated before policy execution
    ): unknown {
        const provider = providers.get(group.providerPack);
        if (!provider)
            throw new InformAiError(
                `Missing declared manifest module for ${group.providerPack}. Repair rulePacks.`,
            );
        return loader.load(group.implementationModule, provider);
    }

    request(
        root: string,
        configs: Readonly<Record<string, ConfigObject>>,
        group: RuntimeContributionGroup,
    ): PolicyRuntimeRequest {
        const selected: Record<string, ConfigObject> = {};
        for (const id of group.ruleIds) {
            if (!Object.hasOwn(configs, id))
                throw new InformAiError(
                    `Missing explicit config for ${id}. Repair its declared owner file.`,
                );
            selected[id] = configs[id];
        }
        return new PolicyRuntimeRequest(root, selected, group.ruleIds);
    }

    // webpieces-disable no-any-unknown -- public exports are validated before use; no concrete execution package is imported
    async createBuildPolicies(
        // webpieces-disable no-any-unknown -- external JSON or runtime exports are validated before policy execution
        exports: unknown,
        request: PolicyRuntimeRequest,
    ): Promise<readonly BuildPolicy[]> {
        if (!exports || typeof exports !== 'object' || !('buildRuleRuntime' in exports)) {
            throw new InformAiError(
                'Build contribution must export buildRuleRuntime.create(request). Repair its public runtime export.',
            );
        }
        const runtime = exports.buildRuleRuntime as BuildRuleRuntime;
        if (!runtime || typeof runtime.create !== 'function')
            throw new InformAiError(
                'Invalid buildRuleRuntime.create. Supply a build runtime factory.',
            );
        const checks = await runtime.create(request);
        if (!Array.isArray(checks))
            throw new InformAiError('Build runtime must return an array of configured checks.');
        const covered = new Set<string>();
        for (const check of checks) {
            if (
                !check ||
                typeof check.name !== 'string' ||
                !check.name ||
                !request.ruleIds.includes(check.configKey) ||
                typeof check.shouldRun !== 'function' ||
                typeof check.run !== 'function'
            ) {
                throw new InformAiError(
                    'Invalid build check. Supply name, declared configKey, shouldRun(), and run(root).',
                );
            }
            covered.add(check.configKey);
        }
        for (const id of request.ruleIds) {
            if (!covered.has(id))
                throw new InformAiError(
                    `Build runtime omitted declared policy ${id}. Supply its actual implementation.`,
                );
        }
        return checks;
    }
}
