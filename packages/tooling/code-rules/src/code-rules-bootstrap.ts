import {
    BaseRuleConfig,
    BuildDebugRequest,
    ConfigObject,
    PolicyDebugSelection,
    PolicyRuntimeRequest,
} from '@webpieces/rules-sdk';
import 'reflect-metadata';
import { CodeRuleRuntime } from './code-policy-composition';
import {
    LoadedConfig,
    MatchRuleConfig,
    NodeRuleRuntimeModuleLoader,
    RuleRuntimeModules,
    RuntimeContributionGroup,
    loadAndValidate,
} from '@webpieces/rules-config';
import { MODIFIED_CODE_MODES } from '@webpieces/rules-sdk';
import { InformAiError } from '@webpieces/tooling-common';

import { ExecutorResult } from './code-validator';
import { CodeRulesApp } from './code-rules-app';
import { MatchRulesHolder } from './code-rules-context';
import { CODE_POLICIES, CodePolicy } from './code-policy-registry';
import { CodeRulesRunRequest, RuleSelection } from './code-rules-run-request';
import { ScanScope } from './scan-scope';
import { DebugAsk, DebugPlan, RuleDebugRun } from './rule-debug-run';
import { rulePackManifest } from './rule-pack';

/**
 * The ONE composition root of a code-rules run, shared by the `validate-code` nx executor and the
 * `wp-validate-code` bin so the two cannot drift. It binds the workspace root and every rule's config,
 * then resolves {@link CodeRulesApp} so inversify builds the whole validator DAG.
 *
 * A DEBUG run (#1027 — any of `--rule` / `--mode` / `--projects`) differs from the gate in exactly four
 * ways, all in memory: only the named rule runs; its mode is replaced when `--mode` is given; its two
 * escape hatches are cleared (the question asked is "what is left?", which a time-boxed OFF must not
 * hide); and every rule reads its files through a {@link ScanRestriction} naming the projects. Nothing
 * is written — webpieces.config.json is untouched, so the gate keeps honouring the committed mode. It
 * prints the rule's own failure text, then one count per project, and fails when any site exists.
 *
 * A rule another rule pack contributes to the build — a repo-local rule (#1330) — is not run here: the
 * debug request is handed to that pack's own `buildDebugRuntime`, which shares {@link RuleDebugRun} so
 * its refusals, banner and counts are identical.
 *
 * A request it cannot run (no config, an unknown rule or project, --mode without --rule) THROWS an
 * {@link InformAiError} naming the cure; the bin's and the executor's top-level handlers print it.
 */
export class CodeRulesBootstrap {
    private readonly debug = new RuleDebugRun();

    async run(workspaceRoot: string, request: CodeRulesRunRequest): Promise<ExecutorResult> {
        const loaded = loadAndValidate(workspaceRoot);
        if (loaded.configPath === null) {
            throw new InformAiError(
                'No webpieces.config.json found at workspace root (or any ancestor).',
            );
        }
        console.log(`\n📄 Loaded config: ${loaded.configPath}`);

        const provider =
            request.rule === undefined || this.isOwnRule(request.rule, loaded)
                ? undefined
                : this.packProvider(request.rule, loaded);
        if (provider !== undefined) return this.runPackDebug(workspaceRoot, loaded, provider, request);

        const plan = request.isDebug() ? await this.plan(workspaceRoot, loaded, request) : undefined;
        if (plan !== undefined) this.debug.printBanner(plan);

        const configs: Record<string, ConfigObject> = {};
        for (const policy of CODE_POLICIES) {
            const config = loaded.rulesConfig[policy.ruleId] as BaseRuleConfig;
            configs[policy.ruleId] = (
                plan?.rule === policy.ruleId ? this.debug.overridden(config, plan) : config
            ) as ConfigObject;
        }
        const runtimeRequest = new PolicyRuntimeRequest(
            workspaceRoot,
            configs,
            CODE_POLICIES.map((policy: CodePolicy) => policy.ruleId),
            loaded.excludePaths.paths,
        );
        const container = await new CodeRuleRuntime().compose(runtimeRequest, plan?.projects);
        container
            .bind(MatchRulesHolder)
            .toConstantValue(new MatchRulesHolder(this.matchRules(loaded, plan)));
        container.bind(RuleSelection).toConstantValue(new RuleSelection(plan?.rule));

        const result = await container.get(CodeRulesApp).run();
        if (plan === undefined) return result;
        // A debug run FAILS whenever a site exists — including a rule that only warns at the gate
        // (no-client-creation-outside-server-or-client at severity "warn") — so it can gate a loop.
        const sites = await this.debug.printCounts(workspaceRoot, plan, container.get(ScanScope), result.success);
        return { success: result.success && sites === 0 };
    }

    /** Validate a debug request against the loaded config and the repo's projects; throws on a refusal. */
    private async plan(
        workspaceRoot: string,
        loaded: LoadedConfig,
        request: CodeRulesRunRequest,
    ): Promise<DebugPlan> {
        const rule = request.rule;
        if (rule === undefined)
            throw this.debug.refusal(
                '--mode and --projects need --rule=<name>: a debug run judges exactly one rule.',
            );
        const modes = this.wholeScopeModesOf(rule, loaded);
        if (modes === undefined) {
            throw this.debug.refusal(
                `--rule=${rule} is not a rule that supports a debug run. Rules that do (they offer ` +
                    `MODIFIED_PROJECTS and RUN_EVERY_TIME): ${this.debuggableRules(loaded).join(', ')}.`,
            );
        }
        return this.debug.plan(
            workspaceRoot,
            new DebugAsk(rule, request.mode, this.committedModeOf(rule, loaded) ?? 'OFF', modes, request.projects),
        );
    }

    /** True for a rule THIS pack runs: a built-in code rule or a match-rule. */
    private isOwnRule(rule: string, loaded: LoadedConfig): boolean {
        return (
            CODE_POLICIES.some((binding: CodePolicy) => binding.ruleId === rule) ||
            loaded.matchRules.some((mr: MatchRuleConfig) => mr.name === rule)
        );
    }

    /**
     * The build contribution of ANOTHER rule pack (a repo-local pack, #1330) that runs `rule`, when the
     * rule's modes support a debug run; undefined otherwise.
     */
    private packProvider(rule: string, loaded: LoadedConfig): RuntimeContributionGroup | undefined {
        return this.packBuildGroups(loaded).find(
            (group: RuntimeContributionGroup) =>
                group.ruleIds.includes(rule) && this.debug.supports(this.schemaModesOf(rule, loaded)),
        );
    }

    private packBuildGroups(loaded: LoadedConfig): readonly RuntimeContributionGroup[] {
        return new RuleRuntimeModules()
            .groups(loaded.ruleRegistry, 'build')
            .filter((group: RuntimeContributionGroup) => group.providerPack !== rulePackManifest.packageName);
    }

    private schemaModesOf(rule: string, loaded: LoadedConfig): readonly string[] {
        return loaded.ruleRegistry.schemaFor(rule)['mode']?.enumValues ?? [];
    }

    /** Hand the debug request to the pack that owns the rule; it refuses, prints and counts as this runner does. */
    private async runPackDebug(
        workspaceRoot: string,
        loaded: LoadedConfig,
        group: RuntimeContributionGroup,
        request: CodeRulesRunRequest,
    ): Promise<ExecutorResult> {
        const modules = new RuleRuntimeModules();
        const exports = modules.load(
            group,
            loaded.ruleRegistry.manifestModules,
            new NodeRuleRuntimeModuleLoader(workspaceRoot),
        );
        const result = await modules.runBuildDebug(
            exports,
            new BuildDebugRequest(
                workspaceRoot,
                new PolicyDebugSelection(request.rule!, request.mode, request.projects),
            ),
        );
        return { success: result.success };
    }

    /** The mode set of a rule that reads its files through ScanScope, or undefined for any other rule. */
    private wholeScopeModesOf(rule: string, loaded: LoadedConfig): readonly string[] | undefined {
        if (loaded.matchRules.some((mr: MatchRuleConfig) => mr.name === rule))
            return MODIFIED_CODE_MODES;
        const binding = CODE_POLICIES.find((each: CodePolicy) => each.ruleId === rule);
        if (binding === undefined) return undefined;
        const modes = binding.schema['mode']?.enumValues ?? [];
        return this.debug.supports(modes) ? modes : undefined;
    }

    /** Every rule a debug run accepts: built-in code rules, match-rules, and other packs' rules (#1330). */
    private debuggableRules(loaded: LoadedConfig): string[] {
        const builtIns = CODE_POLICIES.map((binding: CodePolicy) => binding.ruleId as string);
        const names = [...builtIns, ...loaded.matchRules.map((mr: MatchRuleConfig) => mr.name)];
        const own = names.filter((name: string) => this.wholeScopeModesOf(name, loaded) !== undefined);
        const packs = this.packBuildGroups(loaded)
            .flatMap((group: RuntimeContributionGroup) => [...group.ruleIds])
            .filter((name: string) => this.packProvider(name, loaded) !== undefined);
        return [...own, ...packs];
    }

    private committedModeOf(rule: string, loaded: LoadedConfig): string | undefined {
        const match = loaded.matchRules.find((mr: MatchRuleConfig) => mr.name === rule);
        if (match !== undefined) return match.mode;
        const configured = loaded.rulesConfig[rule as keyof typeof loaded.rulesConfig] as
            | BaseRuleConfig
            | undefined;
        return configured?.mode;
    }

    /** The match-rules, with the debugged one (if it is a match rule) overridden. */
    private matchRules(loaded: LoadedConfig, plan: DebugPlan | undefined): MatchRuleConfig[] {
        return loaded.matchRules.map((mr: MatchRuleConfig) =>
            plan?.rule === mr.name ? this.debug.overridden(mr, plan) : mr,
        );
    }
}
