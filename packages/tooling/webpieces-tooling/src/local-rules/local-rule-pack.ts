import * as path from 'node:path';
import {
    BuildDebugRequest,
    BuildDebugRuntime,
    BuildPolicy,
    BuildPolicyResult,
    BuildRuleRuntime,
    ConfigObject,
    FieldDef,
    MODIFIED_CODE_MODES,
    OwnedRuleDefinition,
    PolicyRuntimeRequest,
    RULE_PACK_API_VERSION,
    RULE_SCHEMA_API_VERSION,
    RuleContribution,
    RuleHelp,
    RulePackManifest,
} from '@webpieces/rules-sdk';
import { BASE_RULE_SCHEMA } from '@webpieces/rules-sdk';
import { HookPolicyRuntimeRequest, HookRuleRuntime, Rule } from '@webpieces/hook-runtime';
import { InformAiError } from '@webpieces/tooling-common';
import { toError } from '@webpieces/tooling-common/to-error';
import { DiffScope, RuleFailError, loadAndValidate, renderRuleFailForHuman } from '@webpieces/rules-config';
import {
    DebugAsk,
    GateScanScope,
    ProjectCatalog,
    RuleDebugRun,
    RunRequestParser,
    ScanRestriction,
    ScanScope,
} from '@webpieces/code-rules';
import { LocalRule, LocalRuleConfig } from './local-rule';
import { LocalSourceHookPolicy } from './local-source-hook-policy';
import { LocalBuildPolicy } from './local-build-policy';

const RULE_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** The version a local pack reports: it ships with the repo, never as an npm release. */
const LOCAL_PACK_VERSION = '0.0.0-local';

/** Validated owner settings for one local rule, or a refusal naming the owner file to repair. */
class LocalRuleConfigs {
    constructor(private readonly configs: Readonly<Record<string, ConfigObject>>) {}

    configFor(rule: LocalRule): LocalRuleConfig {
        const config = this.configs[rule.id];
        if (!config)
            throw new InformAiError(`Missing explicit config for local rule ${rule.id}. Add its entry to the rule pack's owner file.`);
        return config as LocalRuleConfig;
    }
}

/** The source-hook half: one {@link LocalSourceHookPolicy} per rule the runtime request names. */
class LocalSourceRuleRuntime implements HookRuleRuntime {
    constructor(private readonly pack: LocalRulePack) {}

    create(request: HookPolicyRuntimeRequest): readonly Rule[] {
        const configs = new LocalRuleConfigs(request.configs);
        return request.ruleIds.map((id: string) => {
            const rule = this.pack.ruleFor(id);
            return new LocalSourceHookPolicy(configs.configFor(rule), rule);
        });
    }
}

/** The build half: one {@link LocalBuildPolicy} per rule the runtime request names. */
class LocalBuildRuleRuntime implements BuildRuleRuntime {
    constructor(private readonly pack: LocalRulePack) {}

    async create(request: PolicyRuntimeRequest): Promise<readonly BuildPolicy[]> {
        const configs = new LocalRuleConfigs(request.configs);
        return request.ruleIds.map((id: string) => {
            const rule = this.pack.ruleFor(id);
            return new LocalBuildPolicy(configs.configFor(rule), rule, request.excludePaths, new GateScanScope());
        });
    }
}

/**
 * The one-rule DEBUG run of a local rule (#1330) — `wp-validate-code --rule=<id> --mode=RUN_EVERY_TIME
 * --projects=a,b` — with the same refusals, banner, in-memory override and per-project count a built-in
 * code rule gets ({@link RuleDebugRun}). The rule runs through the same {@link LocalBuildPolicy} the gate
 * runs, so disables, the repo's `excludePaths` and the rule's own apply exactly as they do there; only the
 * mode (when `--mode` is given) and the two escape hatches are overridden, in memory. RUN_EVERY_TIME lists
 * every file in the repo and never consults the diff.
 */
class LocalBuildDebugRuntime implements BuildDebugRuntime {
    private readonly debug = new RuleDebugRun();

    constructor(private readonly pack: LocalRulePack) {}

    async run(request: BuildDebugRequest): Promise<BuildPolicyResult> {
        const root = request.workspaceRoot;
        const asked = new RunRequestParser().parse(request.selection.rule, request.selection.mode, request.selection.projects);
        const rule = this.pack.ruleFor(request.selection.rule);
        const loaded = loadAndValidate(root);
        const config = new LocalRuleConfigs(loaded.rulesConfig as Record<string, ConfigObject>).configFor(rule);
        const plan = await this.debug.plan(root, new DebugAsk(rule.id, asked.mode, config.mode ?? 'OFF', MODIFIED_CODE_MODES, asked.projects));
        this.debug.printBanner(plan);
        const diffScope = new DiffScope();
        const scan = new ScanScope(diffScope, new ProjectCatalog(diffScope), new ScanRestriction(plan.projects));
        const policy = new LocalBuildPolicy(this.debug.overridden(config, plan), rule, loaded.excludePaths.paths, scan);
        const ruleSucceeded = await this.runPrintingFailure(policy, root);
        const sites = await this.debug.printCounts(root, plan, scan, ruleSucceeded);
        return new BuildPolicyResult(ruleSucceeded && sites === 0);
    }

    /** The rule's own failure text is printed BEFORE the counts, exactly as a built-in rule's is. */
    private async runPrintingFailure(policy: LocalBuildPolicy, root: string): Promise<boolean> {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- the policy's RuleFailError IS the debug run's report; anything else propagates
        try {
            return (await policy.run(root)).success;
        // webpieces-disable no-any-unknown -- a thrown value is narrowed to the policy's RuleFailError, anything else is rethrown
        } catch (err: unknown) {
            const error = toError(err);
            if (!(error instanceof RuleFailError)) throw error;
            console.error(renderRuleFailForHuman(error));
            return false;
        }
    }
}

/**
 * A repo's OWN rule pack (#1314) — the sixth owner beside webpieces' five, built from {@link LocalRule}s.
 *
 * One module both declares the pack and implements it. It exports the four names the framework loads —
 * `rulePackManifest`, `sourceRuleRuntime`, `buildRuleRuntime` and `buildDebugRuntime` (the one-rule
 * `wp-validate-code --rule=<id>` debug run, #1330) — and every rule is contributed to BOTH runners, the
 * Write/Edit source guard and the build gate, so there is no when-to-run setting:
 *
 * ```ts
 * // webpieces-rules/local-rules.ts
 * import { LocalRulePack } from '@webpieces/webpieces-tooling/local-rules';
 * import { NoTodoCommentRule } from './no-todo-comment';
 *
 * const pack = new LocalRulePack('local-rules', __filename, [new NoTodoCommentRule()]);
 * export const rulePackManifest = pack.rulePackManifest;
 * export const sourceRuleRuntime = pack.sourceRuleRuntime;
 * export const buildRuleRuntime = pack.buildRuleRuntime;
 * export const buildDebugRuntime = pack.buildDebugRuntime;
 * ```
 *
 * declared in `webpieces.config.json` like any pack, with its own owner file:
 * `{ "package": "./webpieces-rules/local-rules.ts", "config": ".webpieces-config/rules/local.json" }`.
 * A `.ts` module is transpiled in memory when it is loaded; there is no build step.
 *
 * Each rule's schema is its `settings` plus a required `mode` (the scope vocabulary built-in diff rules
 * use); the registry adds the framework-owned fields. Nothing has a default: a missing entry or value fails
 * the config load naming the owner file and the seed to paste.
 */
export class LocalRulePack {
    readonly rulePackManifest: RulePackManifest;
    readonly sourceRuleRuntime: HookRuleRuntime;
    readonly buildRuleRuntime: BuildRuleRuntime;
    readonly buildDebugRuntime: BuildDebugRuntime;
    private readonly rules = new Map<string, LocalRule>();

    /**
     * @param packageName the pack's owner name — how the registry and every refusal name it.
     * @param moduleFile the declaring module's own `__filename`: both runtimes are loaded from it.
     * @param rules the pack's rules; ids must be unique kebab-case and not collide with any other pack's.
     */
    constructor(packageName: string, moduleFile: string, rules: readonly LocalRule[]) {
        if (!packageName.trim()) throw new InformAiError('A LocalRulePack needs a nonempty package name, e.g. "local-rules".');
        if (!path.isAbsolute(moduleFile))
            throw new InformAiError(`LocalRulePack ${packageName} needs its module's absolute path. Pass __filename as the second argument.`);
        if (rules.length === 0) throw new InformAiError(`LocalRulePack ${packageName} has no rules. Add at least one LocalRule.`);
        for (const rule of rules) this.add(packageName, rule);
        this.rulePackManifest = new RulePackManifest(
            packageName,
            LOCAL_PACK_VERSION,
            RULE_PACK_API_VERSION,
            rules.map((rule: LocalRule) => this.definition(rule)),
            rules.flatMap((rule: LocalRule) => [
                new RuleContribution(rule.id, packageName, 'source-hook', moduleFile),
                new RuleContribution(rule.id, packageName, 'build', moduleFile),
            ]),
            [],
            [],
        );
        this.sourceRuleRuntime = new LocalSourceRuleRuntime(this);
        this.buildRuleRuntime = new LocalBuildRuleRuntime(this);
        this.buildDebugRuntime = new LocalBuildDebugRuntime(this);
    }

    /** The rule registered under `id`; the runtimes only ever ask for ids this pack's manifest declares. */
    ruleFor(id: string): LocalRule {
        const rule = this.rules.get(id);
        if (!rule) throw new InformAiError(`Local rule pack has no rule ${id}. Repair its rule list.`);
        return rule;
    }

    private add(packageName: string, rule: LocalRule): void {
        if (!RULE_ID.test(rule.id))
            throw new InformAiError(`Local rule id "${rule.id}" in ${packageName} must be kebab-case (e.g. no-todo-comment).`);
        if (this.rules.has(rule.id)) throw new InformAiError(`Local rule ${rule.id} is declared twice in ${packageName}. Keep one.`);
        for (const key of Object.keys(rule.settings)) {
            if (key === 'mode' || Object.hasOwn(BASE_RULE_SCHEMA, key))
                throw new InformAiError(
                    `Local rule ${rule.id} declares the framework-owned setting "${key}". Delete it from settings; every local rule gets mode, ${Object.keys(BASE_RULE_SCHEMA).join(', ')}.`,
                );
        }
        this.rules.set(rule.id, rule);
    }

    private definition(rule: LocalRule): OwnedRuleDefinition {
        const schema: Record<string, FieldDef> = { ...rule.settings, mode: new FieldDef('string', MODIFIED_CODE_MODES) };
        const seed = Object.assign(new ConfigObject(), rule.seed, { turnOffRuleUntilEpoch: 0, turnOffRuleWhileOnBranch: null });
        return new OwnedRuleDefinition(
            rule.id,
            schema,
            RULE_SCHEMA_API_VERSION,
            {},
            seed,
            'rules',
            new RuleHelp(rule.description, `Fix the reported site, or set ${rule.id}.mode in {configFile}.`),
        );
    }
}
