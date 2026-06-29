import { findConfigFile, readRawConfig } from './config-file';
import { defaultRules } from './default-rules';
import { InformAiError } from './inform-ai-error';
import { buildPrGateConfig, PrGateConfig } from './pr-gate-config';
import { ResolvedConfig, ResolvedRuleConfig, RuleOptions } from './types';
import { validatePrGateSection, validateWebpiecesConfig } from './validate-config';
import { WebpiecesRulesConfig } from './WebpiecesRulesConfig';

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
 *  - `rulesConfig` — typed WebpiecesRulesConfig (ai-hook-rules, code-rules).
 *  - `prGate`      — the pr-gate section (pr-gate scripts).
 *  - `configPath`  — absolute path, or null when no config file was found.
 */
export class LoadedConfig {
    constructor(
        readonly resolved: ResolvedConfig,
        readonly rulesConfig: WebpiecesRulesConfig,
        readonly prGate: PrGateConfig,
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
        return new LoadedConfig(
            new ResolvedConfig(new Map(), new Set(), [], null),
            new WebpiecesRulesConfig(),
            buildPrGateConfig(undefined),
            null,
        );
    }

    const consumerConfig = readRawConfig(configPath);
    const overrideRules = consumerConfig.rules || {};

    const errors = [
        ...validateWebpiecesConfig(overrideRules),
        ...validatePrGateSection(consumerConfig['pr-gate']),
    ];
    if (errors.length > 0) {
        throw new InformAiError(
            `webpieces.config.json has ${errors.length} validation error(s) — fix ALL, then retry:\n\n` +
            errors.map(e => `  • ${e}`).join('\n'),
        );
    }

    const rulesDir = consumerConfig.rulesDir ?? [];

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
    const prGate = buildPrGateConfig(consumerConfig['pr-gate']);

    return new LoadedConfig(resolved, rulesConfig, prGate, configPath);
}
