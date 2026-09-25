import 'reflect-metadata';
import { Container } from 'inversify';
import {
    BaseRuleConfig,
    DiffScope,
    InformAiError,
    LoadedConfig,
    MatchRuleConfig,
    MODIFIED_CODE_MODES,
    RULE_SCHEMAS,
    loadAndValidate,
} from '@webpieces/rules-config';

import { ExecutorResult } from './code-validator';
import { CodeRulesApp } from './code-rules-app';
import { WorkspaceRoot, MatchRulesHolder } from './code-rules-context';
import { CONFIG_BINDINGS, ConfigBinding } from './code-rules-config-table';
import { CodeRulesRunRequest, RuleSelection } from './code-rules-run-request';
import { ProjectCatalog, ProjectEntry, ScanRestriction, ScanScope } from './scan-scope';

/** A validated debug run (#1027): the one rule, the mode it runs at, and the projects it is scoped to. */
class DebugPlan {
    constructor(
        readonly rule: string,
        readonly mode: string,
        readonly committedMode: string,
        readonly projects: readonly string[] | undefined,
    ) {}
}

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
 * A request it cannot run (no config, an unknown rule or project, --mode without --rule) THROWS an
 * {@link InformAiError} naming the cure; the bin's and the executor's top-level handlers print it.
 */
export class CodeRulesBootstrap {
    async run(workspaceRoot: string, request: CodeRulesRunRequest): Promise<ExecutorResult> {
        const loaded = loadAndValidate(workspaceRoot);
        if (loaded.configPath === null) {
            throw new InformAiError('No webpieces.config.json found at workspace root (or any ancestor).');
        }
        console.log(`\n📄 Loaded config: ${loaded.configPath}`);

        const plan = request.isDebug() ? this.plan(workspaceRoot, loaded, request) : undefined;
        if (plan !== undefined) this.printBanner(plan);

        // autobind self-binds every @injectable(Singleton) tooling class (replaces the buildProviderModule registry scan)
        const container = new Container({ autobind: true });
        container.bind(WorkspaceRoot).toConstantValue(new WorkspaceRoot(workspaceRoot));
        container.bind(MatchRulesHolder).toConstantValue(new MatchRulesHolder(this.matchRules(loaded, plan)));
        container.bind(RuleSelection).toConstantValue(new RuleSelection(plan?.rule));
        container.bind(ScanRestriction).toConstantValue(new ScanRestriction(plan?.projects));
        for (const binding of CONFIG_BINDINGS) {
            const ConfigClass = binding[0];
            const configured = loaded.rulesConfig[binding[1]] as BaseRuleConfig | undefined;
            const config = configured ?? new ConfigClass();
            container.bind(ConfigClass).toConstantValue(plan?.rule === binding[1] ? this.overridden(config, plan) : config);
        }

        const result = await container.get(CodeRulesApp).run();
        if (plan === undefined) return result;
        // A debug run FAILS whenever a site exists — including a rule that only warns at the gate
        // (no-client-creation-outside-server-or-client at severity "warn") — so it can gate a loop.
        const sites = this.printCounts(workspaceRoot, plan, container.get(ScanScope), result);
        return { success: result.success && sites === 0 };
    }

    /** Validate a debug request against the loaded config and the repo's projects; throws on a refusal. */
    private plan(workspaceRoot: string, loaded: LoadedConfig, request: CodeRulesRunRequest): DebugPlan {
        const rule = request.rule;
        if (rule === undefined) throw this.refusal('--mode and --projects need --rule=<name>: a debug run judges exactly one rule.');
        const modes = this.wholeScopeModesOf(rule, loaded);
        if (modes === undefined) {
            throw this.refusal(`--rule=${rule} is not a code rule that supports a debug run. Rules that do (they offer ` +
                `MODIFIED_PROJECTS and RUN_EVERY_TIME): ${this.debuggableRules(loaded).join(', ')}.`);
        }
        const committedMode = this.committedModeOf(rule, loaded) ?? 'OFF';
        const mode = request.mode ?? committedMode;
        if (!modes.includes(mode) || mode === 'OFF') {
            const why = request.mode === undefined ? `its committed mode is ${committedMode}` : `--mode=${mode} is not one of its modes`;
            throw this.refusal(`${rule} cannot run: ${why}. Pass --mode=<one of ${modes.filter((m: string) => m !== 'OFF').join(', ')}>.`);
        }
        const unknown = (request.projects ?? []).filter((name: string) => !this.projectNames(workspaceRoot).includes(name));
        if (unknown.length > 0) {
            throw this.refusal(`--projects names no such nx project: ${unknown.join(', ')}. Known projects: ` +
                `${this.projectNames(workspaceRoot).join(', ')}.`);
        }
        return new DebugPlan(rule, mode, committedMode, request.projects);
    }

    private refusal(reason: string): InformAiError {
        return new InformAiError(`[debug run] ${reason}`);
    }

    /** The mode set of a rule that reads its files through ScanScope, or undefined for any other rule. */
    private wholeScopeModesOf(rule: string, loaded: LoadedConfig): readonly string[] | undefined {
        if (loaded.matchRules.some((mr: MatchRuleConfig) => mr.name === rule)) return MODIFIED_CODE_MODES;
        if (!CONFIG_BINDINGS.some((binding: ConfigBinding) => binding[1] === rule)) return undefined;
        const modes = RULE_SCHEMAS[rule]?.['mode']?.enumValues ?? [];
        return modes.includes('MODIFIED_PROJECTS') && modes.includes('RUN_EVERY_TIME') ? modes : undefined;
    }

    private debuggableRules(loaded: LoadedConfig): string[] {
        const builtIns = CONFIG_BINDINGS.map((binding: ConfigBinding) => binding[1] as string);
        const names = [...builtIns, ...loaded.matchRules.map((mr: MatchRuleConfig) => mr.name)];
        return names.filter((name: string) => this.wholeScopeModesOf(name, loaded) !== undefined);
    }

    private committedModeOf(rule: string, loaded: LoadedConfig): string | undefined {
        const match = loaded.matchRules.find((mr: MatchRuleConfig) => mr.name === rule);
        if (match !== undefined) return match.mode;
        const configured = loaded.rulesConfig[rule as keyof typeof loaded.rulesConfig] as BaseRuleConfig | undefined;
        return configured?.mode;
    }

    private projectNames(workspaceRoot: string): string[] {
        return new ProjectCatalog(new DiffScope()).all(workspaceRoot).map((p: ProjectEntry) => p.name).sort();
    }

    /** The match-rules, with the debugged one (if it is a match rule) overridden. */
    private matchRules(loaded: LoadedConfig, plan: DebugPlan | undefined): MatchRuleConfig[] {
        return loaded.matchRules.map((mr: MatchRuleConfig) => (plan?.rule === mr.name ? this.overridden(mr, plan) : mr));
    }

    /** A copy of `config` at the plan's mode with both escape hatches cleared. The original is untouched. */
    private overridden<C extends BaseRuleConfig>(config: C, plan: DebugPlan): C {
        const copy = Object.assign(Object.create(Object.getPrototypeOf(config) as object) as C, config);
        copy.mode = plan.mode;
        copy.turnOffRuleUntilEpoch = 0;
        copy.turnOffRuleWhileOnBranch = null;
        return copy;
    }

    private printBanner(plan: DebugPlan): void {
        console.log('');
        console.log(`🔍 DEBUG RUN of ${plan.rule} — NOT the gate. webpieces.config.json is unchanged and nothing is written.`);
        console.log(`   Mode: ${plan.mode} (committed: ${plan.committedMode})` +
            ` · Projects: ${plan.projects === undefined ? 'every project' : plan.projects.join(', ')}` +
            ' · escape hatches (turnOffRuleUntilEpoch / turnOffRuleWhileOnBranch) ignored for this run');
    }

    /** Print one count per project and return the total. */
    private printCounts(workspaceRoot: string, plan: DebugPlan, scan: ScanScope, result: ExecutorResult): number {
        const counts = scan.countsByProject(workspaceRoot);
        const names = plan.projects ?? Array.from(counts.keys()).sort();
        const total = Array.from(counts.values()).reduce((sum: number, n: number) => sum + n, 0);
        console.log('');
        console.log(`🔍 ${plan.rule} at ${plan.mode}: ${total} site(s) left`);
        for (const name of names) console.log(`   ${name}: ${counts.get(name) ?? 0}`);
        if (!result.success && total === 0) {
            console.log('   (the rule failed without reporting sites — read its output above)');
        }
        console.log('');
        return total;
    }
}
