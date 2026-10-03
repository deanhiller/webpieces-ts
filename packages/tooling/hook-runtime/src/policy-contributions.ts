import * as path from 'node:path';
import { BaseRuleConfig, ConfigObject, ExecutionKind } from '@webpieces/rules-sdk';
import {
    AbstractRule,
    LoadedConfig,
    Option,
    NodeRuleRuntimeModuleLoader,
    RuleRuntimeModules,
    RuntimeContributionGroup,
} from '@webpieces/rules-config';
import { InformAiError } from '@webpieces/tooling-common';
import { HookRuleRuntime, HookPolicyRuntimeRequest } from './policy-runtime';
import { Rule, EditContext, FileContext, BashContext, Violation } from './core/types';
import { FixHint } from './core/fix-hint';

/** The framework enforces explicit OFF and escape hatches even for client-authored implementations. */
class ConfiguredHookPolicy extends AbstractRule<BaseRuleConfig> implements Rule {
    readonly description: string;
    readonly scope: Rule['scope'];
    readonly files: readonly string[];
    readonly defaultOptions: Rule['defaultOptions'];
    readonly fixHint: FixHint;

    constructor(
        config: BaseRuleConfig,
        private readonly implementation: Rule,
        configFile: string,
    ) {
        super(config, implementation.name, implementation.configKey);
        this.description = implementation.description;
        this.scope = implementation.scope;
        this.files = implementation.files;
        this.defaultOptions = implementation.defaultOptions;
        const hint = implementation.fixHint;
        this.fixHint = new FixHint(
            hint.violation.replaceAll('{configFile}', configFile),
            hint.mainMessage.replaceAll('{configFile}', configFile),
            hint.fixOptions.map(
                (option: Option) =>
                    new Option(
                        option.text.replaceAll('{configFile}', configFile),
                        option.preferred,
                    ),
            ),
            hint.escape,
        );
    }

    override shouldRun(): boolean {
        return super.shouldRun() && this.implementation.shouldRun();
    }
    check(context: EditContext | FileContext | BashContext): readonly Violation[] {
        return this.implementation.check(context);
    }
}

/** Composition may supply its own public runtime directly; all other declared modules use Node transport. */
export class HookPolicyContributions {
    constructor(private readonly composed: ReadonlyMap<string, HookRuleRuntime>) {}

    load(
        loaded: LoadedConfig,
        kind: Extract<ExecutionKind, 'source-hook' | 'workflow-guard'>,
    ): readonly Rule[] {
        if (loaded.configPath === null) return [];
        const root = path.dirname(loaded.configPath),
            modules = new RuleRuntimeModules();
        const loader = new NodeRuleRuntimeModuleLoader(root),
            result: Rule[] = [];
        for (const group of modules.groups(loaded.ruleRegistry, kind)) {
            const runtime =
                this.composed.get(group.implementationModule) ??
                this.runtime(
                    modules.load(group, loaded.ruleRegistry.manifestModules, loader),
                    group,
                );
            const request = modules.request(
                root,
                loaded.rulesConfig as Record<string, ConfigObject>,
                group,
            );
            const rules = runtime.create(new HookPolicyRuntimeRequest(request, loaded.commands));
            this.validate(rules, group);
            for (const rule of rules) {
                const filename = loaded.policyFiles?.targetFiles.get(rule.configKey);
                if (!filename)
                    throw new InformAiError(
                        `Missing declared owner config path for ${rule.configKey}. Repair the root declaration.`,
                    );
                result.push(
                    new ConfiguredHookPolicy(
                        request.configs[rule.configKey] as BaseRuleConfig,
                        rule,
                        filename,
                    ),
                );
            }
        }
        return result;
    }

    // webpieces-disable no-any-unknown -- the selected execution-family module is validated before invocation
    private runtime(exports: unknown, group: RuntimeContributionGroup): HookRuleRuntime {
        const name =
            group.executionKind === 'source-hook' ? 'sourceRuleRuntime' : 'workflowRuleRuntime';
        if (!exports || typeof exports !== 'object' || !(name in exports)) {
            throw new InformAiError(
                `${group.implementationModule} must export ${name}.create(request). Repair the declared public runtime module.`,
            );
        }
        // webpieces-disable no-any-unknown -- external JSON or runtime exports are validated before policy execution
        const runtime = (exports as Record<string, unknown>)[name] as HookRuleRuntime;
        if (!runtime || typeof runtime.create !== 'function')
            throw new InformAiError(`Invalid ${name}.create in ${group.implementationModule}.`);
        return runtime;
    }

    private validate(rules: readonly Rule[], group: RuntimeContributionGroup): void {
        if (!Array.isArray(rules))
            throw new InformAiError(
                `${group.implementationModule} must return an array of configured hook policies.`,
            );
        const covered = new Set<string>();
        for (const rule of rules) {
            if (
                !rule ||
                !group.ruleIds.includes(rule.configKey) ||
                typeof rule.name !== 'string' ||
                !rule.name ||
                typeof rule.description !== 'string' ||
                !['edit', 'file', 'bash'].includes(rule.scope) ||
                !Array.isArray(rule.files) ||
                rule.files.some((file: string) => typeof file !== 'string') ||
                !rule.defaultOptions ||
                !rule.fixHint ||
                typeof rule.check !== 'function' ||
                typeof rule.shouldRun !== 'function'
            ) {
                throw new InformAiError(
                    `Invalid hook policy returned by ${group.implementationModule}. Supply the declared configKey and complete hook contract.`,
                );
            }
            covered.add(rule.configKey);
        }
        for (const id of group.ruleIds) {
            if (!covered.has(id))
                throw new InformAiError(
                    `${group.implementationModule} omitted declared hook policy ${id}. Supply its actual implementation.`,
                );
        }
    }
}
