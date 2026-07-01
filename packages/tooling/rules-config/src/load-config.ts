import { buildCommandsConfig, CommandsConfig } from './commands-config';
import { findConfigFile, readRawConfig } from './config-file';
import { defaultRules } from './default-rules';
import { ExcludePaths } from './exclude-hook-paths';
import { InformAiError } from './inform-ai-error';
import { PrGateConfig } from './pr-gate-config';
import { ResolvedConfig, ResolvedRuleConfig, RuleOptions } from './types';
import { validateCommandsSection, validateExcludePaths, validateSectionPlacement, validateWebpiecesConfig } from './validate-config';
import { WebpiecesRulesConfig } from './WebpiecesRulesConfig';

// Inject the canonical command strings (from the `commands` section) as the DEFAULT for the guards
// that surface them in their fix hints, so a project renames a command in one place. Only fills a
// gap — an explicit per-guard override wins. Mutates the merged guard entries in place.
function applyCommandDefaults(
    // webpieces-disable no-any-unknown -- opaque merged rule/guard map
    rules: Record<string, Record<string, unknown>>,
    commands: CommandsConfig,
): void {
    const prCreation = rules['pr-creation-guard'];
    if (prCreation && prCreation['upsertPrCommand'] === undefined) {
        prCreation['upsertPrCommand'] = commands.upsertPr;
    }
    const mergeInProgress = rules['merge-in-progress-guard'];
    if (mergeInProgress && mergeInProgress['mergeCompleteCommand'] === undefined) {
        mergeInProgress['mergeCompleteCommand'] = commands.mergeComplete;
    }
}

// webpieces-disable no-any-unknown -- merging opaque option bags from config JSON
function mergeRule(
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

// Parse the (already-validated) raw excludePaths block into the typed ExcludePaths. Defensive
// defaults keep this total even though validateExcludePaths guarantees both string[] lists are set.
// webpieces-disable no-any-unknown -- `raw` is opaque consumer JSON until narrowed here
function parseExcludePaths(raw: unknown): ExcludePaths {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return new ExcludePaths([], []);
    // webpieces-disable no-any-unknown -- validateExcludePaths already proved both are string[]
    const s = raw as Record<string, string[]>;
    const rules = Array.isArray(s['rules']) ? s['rules'].filter(p => typeof p === 'string') : [];
    const guards = Array.isArray(s['guards']) ? s['guards'].filter(p => typeof p === 'string') : [];
    return new ExcludePaths(rules, guards);
}

function buildWebpiecesRulesConfig(
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

/**
 * Everything a consumer might need from webpieces.config.json, produced from ONE parse + ONE
 * validation pass. Data-only (per CLAUDE.md, classes for data):
 *  - `resolved`    — Map-based view merged with defaultRules (nx executors).
 *  - `rulesConfig` — typed WebpiecesRulesConfig (ai-hook-rules, code-rules); rules + hookGuards merged.
 *  - `commands`    — the `commands` section (gated commands + pr-gate).
 *  - `prGate`      — convenience alias of `commands.prGate` (pr-gate scripts).
 *  - `excludePaths`— the required `excludePaths` block (per-category glob suppression lists).
 *  - `configPath`  — absolute path, or null when no config file was found.
 */
export class LoadedConfig {
    constructor(
        readonly resolved: ResolvedConfig,
        readonly rulesConfig: WebpiecesRulesConfig,
        readonly commands: CommandsConfig,
        readonly prGate: PrGateConfig,
        readonly excludePaths: ExcludePaths,
        readonly configPath: string | null,
    ) {}
}

/**
 * The single load+validate entry point for ALL consumers (ai-hook-rules, code-rules,
 * nx-webpieces-rules, pr-gate scripts). Reads webpieces.config.json once, validates BOTH the `rules`
 * map and the top-level `pr-gate` block, and throws one InformAiError listing every error. When no
 * config file is found it returns lenient empties/defaults (matching prior no-file behavior).
 */
export function loadAndValidate(cwd: string): LoadedConfig {
    const configPath = findConfigFile(cwd);
    if (!configPath) {
        const emptyCommands = buildCommandsConfig(undefined);
        return new LoadedConfig(
            new ResolvedConfig(new Map(), new Set(), [], null),
            new WebpiecesRulesConfig(),
            emptyCommands,
            emptyCommands.prGate,
            new ExcludePaths([], []),
            null,
        );
    }

    const consumerConfig = readRawConfig(configPath);
    const rulesSection = consumerConfig.rules || {};
    const hookGuardsSection = consumerConfig.hookGuards || {};
    const legacyPrGate = consumerConfig['pr-gate'];

    // rules + hookGuards are validated/loaded as one flat name→config map (the runtime dispatches by
    // each rule's own `scope`, so it needs no section knowledge). Placement is enforced separately.
    const overrideRules = { ...rulesSection, ...hookGuardsSection };

    // A non-empty rulesDir means custom rules exist (loaded at runtime by ai-hook-rules), so a config
    // key with no built-in schema may be a legitimate custom rule. With no rulesDir, an unknown key is
    // a dead/typo'd entry and is rejected (validateWebpiecesConfig).
    const rulesDir = consumerConfig.rulesDir ?? [];

    const errors = [
        ...validateWebpiecesConfig(overrideRules, rulesDir.length > 0),
        ...validateSectionPlacement(rulesSection, hookGuardsSection),
        ...validateCommandsSection(consumerConfig.commands, legacyPrGate),
        ...validateExcludePaths(consumerConfig.excludePaths),
    ];
    if (errors.length > 0) {
        throw new InformAiError(
            `webpieces.config.json has ${errors.length} validation error(s) — fix ALL, then retry:\n\n` +
            errors.map(e => `  • ${e}`).join('\n'),
        );
    }
    const commands = buildCommandsConfig(consumerConfig.commands, legacyPrGate);
    applyCommandDefaults(overrideRules, commands);

    const userConfiguredRuleNames = new Set(Object.keys(overrideRules));
    const mergedRules = new Map<string, ResolvedRuleConfig>();
    const allRuleNames = new Set([
        ...Object.keys(defaultRules),
        ...Object.keys(overrideRules),
    ]);
    for (const name of allRuleNames) {
        mergedRules.set(name, mergeRule(defaultRules[name], overrideRules[name]));
    }
    const resolved = new ResolvedConfig(mergedRules, userConfiguredRuleNames, rulesDir, configPath);

    const rulesConfig = buildWebpiecesRulesConfig(overrideRules, rulesDir);
    const excludePaths = parseExcludePaths(consumerConfig.excludePaths);

    return new LoadedConfig(resolved, rulesConfig, commands, commands.prGate, excludePaths, configPath);
}
