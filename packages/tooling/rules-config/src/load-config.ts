import * as path from 'path';
import { injectable, bindingScopeValues } from 'inversify';

import { buildCommandsConfig, CommandsConfig } from './commands-config';
import { formatConfigErrorsBanner } from './config-error-banner';
import { ConfigFile } from './config-file';
import { defaultRules } from './default-rules';
import { ExcludePaths } from './exclude-hook-paths';
import { InformAiError } from './inform-ai-error';
import { PrGateConfig } from './pr-gate-config';
import { ResolvedConfig, ResolvedRuleConfig, RuleOptions } from './types';
import { validateCommandsSection } from './commands-section-validators';
import { validateTopLevelKeys } from './config-key-rules';
import { validateExcludePaths, validateMatchRulesSection, validateSectionPlacement, validateWebpiecesConfig } from './validate-config';
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

// Renamed rules used to be normalized here — a DEPRECATED_RULE_ALIASES table rewrote the old key to its
// canonical name BEFORE validation, so no validator ever saw it and no consumer was ever told. That is why
// the aliases could never be removed: the old names kept working forever. The renames now live in
// RETIRED_CONFIG_KEYS as hard errors naming the new key. See retired-config-keys.ts for the policy.

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
                new ExcludePaths([]),
                [],
                null,
            );
        }

        const consumerConfig = this.configFile.readRawConfig(configPath);
        const rulesSection = consumerConfig.rules || {};
        const hookGuardsSection = consumerConfig.hookGuards || {};
        // Read only so validateCommandsSection can REJECT it. There is no fallback to it — a config
        // carrying the retired top-level block never loads, so reading it as a value would be dead code.
        const legacyPrGate = consumerConfig['pr-gate'];

        // rules + hookGuards are validated/loaded as one flat name→config map (the runtime dispatches
        // by each rule's own `scope`). Placement is enforced separately.
        const overrideRules = { ...rulesSection, ...hookGuardsSection };

        const rulesDir = consumerConfig.rulesDir ?? [];

        // The repo root (dir holding webpieces.config.json) lets checklists[].docs existence be checked.
        const repoRoot = path.dirname(configPath);
        const errors = [
            // webpieces-disable no-any-unknown -- the raw parsed config is opaque; only key names are read
            ...validateTopLevelKeys(consumerConfig as unknown as Record<string, unknown>),
            ...validateWebpiecesConfig(overrideRules, rulesDir.length > 0),
            ...validateSectionPlacement(rulesSection, hookGuardsSection),
            ...validateCommandsSection(consumerConfig.commands, legacyPrGate, repoRoot),
            ...validateExcludePaths(consumerConfig.excludePaths),
            ...validateMatchRulesSection(consumerConfig['match-rules']),
        ];
        if (errors.length > 0) {
            throw new InformAiError(this.formatConfigErrorsBanner(errors));
        }

        const commands = buildCommandsConfig(consumerConfig.commands);
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
        // The whole-repo build guard REFUSES a build of the world and prints the narrow command
        // instead. That command must be the one this repo's gate actually runs — the guard hard-coding
        // its own copy is how a message starts teaching a command the project no longer uses.
        const wholeRepoBuild = rules['whole-repo-build-guard'];
        if (wholeRepoBuild && wholeRepoBuild['affectedBuildCommand'] === undefined) {
            wholeRepoBuild['affectedBuildCommand'] = commands.prGate.buildCommand;
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

    // Parse the (already-validated) raw excludePaths block into the typed ExcludePaths. The ONLY accepted
    // shape is a bare string[]; the retired two-list object cannot reach here, because validateExcludePaths
    // has already failed the load with the migration instruction.
    // webpieces-disable no-any-unknown -- `raw` is opaque consumer JSON until narrowed here
    private parseExcludePaths(raw: unknown): ExcludePaths {
        if (!Array.isArray(raw)) return new ExcludePaths([]);
        return new ExcludePaths(raw.filter(p => typeof p === 'string'));
    }

    // Parse the (already-validated) raw match-rules array into typed MatchRuleConfig[]. The entries use
    // the canonical field names (turnOffRuleUntilEpoch / turnOffRuleWhileOnBranch) that the match-rules
    // engine reads directly, so no normalization is needed.
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

    // Assemble the validation-failure banner. Every error here came from validating this ONE file, so
    // the cure is always "edit it" — see config-error-banner.ts for why nothing else belongs in it.
    private formatConfigErrorsBanner(errors: string[]): string {
        return formatConfigErrorsBanner(errors);
    }
}

// Temporary migration delegator — consumers migrate to injecting ConfigLoader over follow-up PRs,
// then this free function is removed. The logic now lives in the injected ConfigLoader class.
const configLoaderSvc = new ConfigLoader(new ConfigFile());

// webpieces-disable no-function-outside-class -- temporary back-compat delegator to ConfigLoader; removed once all 118 consumers inject it
export function loadAndValidate(cwd: string): LoadedConfig {
    return configLoaderSvc.loadAndValidate(cwd);
}
