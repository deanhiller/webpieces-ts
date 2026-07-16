import { injectable, bindingScopeValues } from 'inversify';

import { buildCommandsConfig, CommandsConfig } from './commands-config';
import { ConfigFile } from './config-file';
import { defaultRules } from './default-rules';
import { ExcludePaths } from './exclude-hook-paths';
import { InformAiError } from './inform-ai-error';
import { PrGateConfig } from './pr-gate-config';
import { ResolvedConfig, ResolvedRuleConfig, RuleOptions } from './types';
import { validateCommandsSection, validateExcludePaths, validateMatchRulesSection, validateSectionPlacement, validateWebpiecesConfig } from './validate-config';
import { MatchRuleConfig } from './match-rules-config';
import { WebpiecesRulesConfig } from './WebpiecesRulesConfig';

/**
 * Everything a consumer might need from webpieces.config.json, produced from ONE parse + ONE
 * validation pass. Data-only (per CLAUDE.md, classes for data).
 */
export class LoadedConfig {
    // eslint-disable-next-line @typescript-eslint/max-params
    constructor(
        readonly resolved: ResolvedConfig,
        readonly rulesConfig: WebpiecesRulesConfig,
        readonly commands: CommandsConfig,
        readonly prGate: PrGateConfig,
        readonly excludePaths: ExcludePaths,
        readonly matchRules: readonly MatchRuleConfig[],
        readonly configPath: string | null,
    ) {}
}

// Config keys that were renamed. A project's webpieces.config.json may still use the OLD key (it can
// legitimately lag the published rules-config by a release), so normalize any deprecated key to its
// canonical name BEFORE validation/placement/loading — every downstream consumer then sees one name.
const DEPRECATED_RULE_ALIASES: Readonly<Record<string, string>> = {
    'pr-merge-cleanup': 'pr-merge-guard',
    'pr-creation-guard': 'pr-creation-or-push-guard',
};

// webpieces-disable no-any-unknown -- opaque per-rule option bags from consumer JSON, validated later
type RuleSectionMap = Record<string, Record<string, unknown>>;

/**
 * The single load+validate entry point for ALL consumers (ai-hook-rules, code-rules,
 * nx-webpieces-rules, pr-gate scripts). `@injectable(bindingScopeValues.Singleton)` + injects {@link ConfigFile} so it appears
 * in the rules-config DI design.
 */
@injectable(bindingScopeValues.Singleton)
export class ConfigLoader {
    constructor(private readonly configFile: ConfigFile) {}

    /**
     * Reads webpieces.config.json once, validates BOTH the `rules` map and the top-level `pr-gate`
     * block, and throws one InformAiError listing every error. When no config file is found it returns
     * lenient empties/defaults (matching prior no-file behavior).
     */
    // webpieces-disable max-lines-new-methods -- the single load+validate pass is one cohesive method
    loadAndValidate(cwd: string): LoadedConfig {
        const configPath = this.configFile.findConfigFile(cwd);
        if (!configPath) {
            const emptyCommands = buildCommandsConfig(undefined);
            return new LoadedConfig(
                new ResolvedConfig(new Map(), new Set(), [], null),
                new WebpiecesRulesConfig(),
                emptyCommands,
                emptyCommands.prGate,
                new ExcludePaths([], []),
                [],
                null,
            );
        }

        const consumerConfig = this.configFile.readRawConfig(configPath);
        const rulesSection = this.normalizeDeprecatedKeys(consumerConfig.rules || {});
        const hookGuardsSection = this.normalizeDeprecatedKeys(consumerConfig.hookGuards || {});
        const legacyPrGate = consumerConfig['pr-gate'];

        // rules + hookGuards are validated/loaded as one flat name→config map (the runtime dispatches
        // by each rule's own `scope`). Placement is enforced separately.
        const overrideRules = { ...rulesSection, ...hookGuardsSection };

        const rulesDir = consumerConfig.rulesDir ?? [];

        const errors = [
            ...validateWebpiecesConfig(overrideRules, rulesDir.length > 0),
            ...validateSectionPlacement(rulesSection, hookGuardsSection),
            ...validateCommandsSection(consumerConfig.commands, legacyPrGate),
            ...validateExcludePaths(consumerConfig.excludePaths),
            ...validateMatchRulesSection(consumerConfig['match-rules']),
        ];
        if (errors.length > 0) {
            throw new InformAiError(this.formatConfigErrorsBanner(errors));
        }
        const commands = buildCommandsConfig(consumerConfig.commands, legacyPrGate);
        this.applyCommandDefaults(overrideRules, commands);

        const userConfiguredRuleNames = new Set(Object.keys(overrideRules));
        const mergedRules = new Map<string, ResolvedRuleConfig>();
        const allRuleNames = new Set([
            ...Object.keys(defaultRules),
            ...Object.keys(overrideRules),
        ]);
        for (const name of allRuleNames) {
            mergedRules.set(name, this.mergeRule(defaultRules[name], overrideRules[name]));
        }
        const resolved = new ResolvedConfig(mergedRules, userConfiguredRuleNames, rulesDir, configPath);

        const rulesConfig = this.buildWebpiecesRulesConfig(overrideRules, rulesDir);
        const excludePaths = this.parseExcludePaths(consumerConfig.excludePaths);
        const matchRules = this.parseMatchRules(consumerConfig['match-rules']);

        return new LoadedConfig(resolved, rulesConfig, commands, commands.prGate, excludePaths, matchRules, configPath);
    }

    // Inject the canonical command strings (from the `commands` section) as the DEFAULT for the guards
    // that surface them in their fix hints. Only fills a gap — an explicit per-guard override wins.
    private applyCommandDefaults(
        // webpieces-disable no-any-unknown -- opaque merged rule/guard map
        rules: Record<string, Record<string, unknown>>,
        commands: CommandsConfig,
    ): void {
        const prCreation = rules['pr-creation-or-push-guard'];
        if (prCreation && prCreation['upsertPrCommand'] === undefined) {
            prCreation['upsertPrCommand'] = commands.upsertPr;
        }
        const mergeInProgress = rules['merge-in-progress-guard'];
        if (mergeInProgress && mergeInProgress['mergeCompleteCommand'] === undefined) {
            mergeInProgress['mergeCompleteCommand'] = commands.mergeComplete;
        }
    }

    // webpieces-disable no-any-unknown -- merging opaque option bags from config JSON
    private mergeRule(
        // webpieces-disable no-any-unknown -- opaque option bag
        baseRule: Record<string, unknown> | undefined,
        // webpieces-disable no-any-unknown -- opaque option bag
        overrideRule: Record<string, unknown> | undefined,
    ): ResolvedRuleConfig {
        if (!baseRule && !overrideRule) return new ResolvedRuleConfig({ mode: 'OFF' });
        if (!baseRule) return new ResolvedRuleConfig(overrideRule! as RuleOptions);
        if (!overrideRule) return new ResolvedRuleConfig(baseRule as RuleOptions);

        // webpieces-disable no-any-unknown -- building merged option bag
        const merged: Record<string, unknown> = {};
        for (const key of Object.keys(baseRule)) merged[key] = baseRule[key];
        for (const key of Object.keys(overrideRule)) merged[key] = overrideRule[key];
        return new ResolvedRuleConfig(merged as RuleOptions);
    }

    // Parse the (already-validated) raw excludePaths block into the typed ExcludePaths.
    // webpieces-disable no-any-unknown -- `raw` is opaque consumer JSON until narrowed here
    private parseExcludePaths(raw: unknown): ExcludePaths {
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return new ExcludePaths([], []);
        // webpieces-disable no-any-unknown -- validateExcludePaths already proved both are string[]
        const s = raw as Record<string, string[]>;
        const rules = Array.isArray(s['rules']) ? s['rules'].filter(p => typeof p === 'string') : [];
        const guards = Array.isArray(s['guards']) ? s['guards'].filter(p => typeof p === 'string') : [];
        return new ExcludePaths(rules, guards);
    }

    // Parse the (already-validated) raw match-rules array into typed MatchRuleConfig[].
    // webpieces-disable no-any-unknown -- validated array; each entry cast to the typed MatchRuleConfig
    private parseMatchRules(raw: unknown): MatchRuleConfig[] {
        if (!Array.isArray(raw)) return [];
        return raw as MatchRuleConfig[];
    }

    private buildWebpiecesRulesConfig(
        // webpieces-disable no-any-unknown -- JSON values are opaque until assigned to typed fields
        rawRules: Record<string, Record<string, unknown>>,
        rulesDir: string[],
    ): WebpiecesRulesConfig {
        const typed = new WebpiecesRulesConfig();
        for (const key of Object.keys(rawRules)) {
            // webpieces-disable no-any-unknown -- dynamic key assignment to typed class
            (typed as Record<string, unknown>)[key] = rawRules[key];
        }
        typed.rulesDir = rulesDir;
        return typed;
    }

    private normalizeDeprecatedKeys(section: RuleSectionMap): RuleSectionMap {
        const out: RuleSectionMap = {};
        for (const key of Object.keys(section)) {
            out[DEPRECATED_RULE_ALIASES[key] ?? key] = section[key];
        }
        return out;
    }

    // Assemble the validation-failure banner. Most of these errors are version skew, not bad config.
    private formatConfigErrorsBanner(errors: string[]): string {
        return (
            `webpieces.config.json has ${errors.length} validation error(s) — fix ALL, then retry:\n\n` +
            errors.map(e => `  • ${e}`).join('\n') +
            `\n\n👉 FIX ORDER (do NOT start by deleting keys — that usually deletes VALID config):\n` +
            `  1. Run \`pnpm install\`. It is ALWAYS allowed through the guard (installer bypass), even ` +
            `while this config is invalid. This is the #1 cause: your installed @webpieces guard is a ` +
            `release BEHIND webpieces.config.json (a dep bump updated the config + lockfile, but ` +
            `node_modules here was never re-installed), so the running validator doesn't know the newer ` +
            `rule names/values yet. \`pnpm install\` syncs node_modules to the pinned version.\n` +
            `  2. Retry your command. If the errors are gone, you're DONE — do not touch webpieces.config.json.\n` +
            `  3. ONLY if an error survives a fresh install is it a genuine typo / removed / renamed rule. ` +
            `Then edit webpieces.config.json (edits to it are ALWAYS allowed) to fix each • above.`
        );
    }
}

// Temporary migration delegator — consumers migrate to injecting ConfigLoader over follow-up PRs,
// then this free function is removed. The logic now lives in the injected ConfigLoader class.
const configLoaderSvc = new ConfigLoader(new ConfigFile());

// webpieces-disable no-function-outside-class -- temporary back-compat delegator to ConfigLoader; removed once all 118 consumers inject it
export function loadAndValidate(cwd: string): LoadedConfig {
    return configLoaderSvc.loadAndValidate(cwd);
}
