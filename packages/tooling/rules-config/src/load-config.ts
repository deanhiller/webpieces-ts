import * as fs from 'fs';
import * as path from 'path';

import { defaultRules } from './default-rules';
import { ResolvedConfig, ResolvedRuleConfig, RuleOptions } from './types';

export const CONFIG_FILENAME = 'webpieces.config.json';

// webpieces-disable no-any-unknown -- consumer JSON config has opaque rule option values
interface RawConfigFile {
    extends?: string;
    rules?: Record<string, Record<string, unknown>>;
    rulesDir?: string[];
}

/**
 * Walk up from `startDir` looking for webpieces.config.json.
 */
export function findConfigFile(startDir: string): string | null {
    let dir = startDir;
    while (true) {
        const primary = path.join(dir, CONFIG_FILENAME);
        if (fs.existsSync(primary)) return primary;
        const parent = path.dirname(dir);
        if (parent === dir) return null;
        dir = parent;
    }
}

// webpieces-disable no-any-unknown -- merging opaque option bags from config JSON
function mergeRule(
    // webpieces-disable no-any-unknown -- opaque option bag
    baseRule: Record<string, unknown> | undefined,
    // webpieces-disable no-any-unknown -- opaque option bag
    overrideRule: Record<string, unknown> | undefined,
): ResolvedRuleConfig {
    if (!baseRule && !overrideRule) return new ResolvedRuleConfig(false, {});
    if (!baseRule) return new ResolvedRuleConfig(enabledOf(overrideRule!), overrideRule as RuleOptions);
    if (!overrideRule) return new ResolvedRuleConfig(enabledOf(baseRule), baseRule as RuleOptions);

    // webpieces-disable no-any-unknown -- building merged option bag
    const merged: Record<string, unknown> = {};
    for (const key of Object.keys(baseRule)) merged[key] = baseRule[key];
    for (const key of Object.keys(overrideRule)) merged[key] = overrideRule[key];
    return new ResolvedRuleConfig(enabledOf(merged), merged as RuleOptions);
}

// webpieces-disable no-any-unknown -- opaque option bag
function enabledOf(bag: Record<string, unknown>): boolean {
    return bag['enabled'] !== false;
}

function readRawConfig(configPath: string): RawConfigFile | null {
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        const raw = fs.readFileSync(configPath, 'utf8');
        return JSON.parse(raw) as RawConfigFile;
        // webpieces-disable catch-error-pattern -- malformed config fails open so missing config doesn't break validators
    } catch (err: unknown) {
        //const error = toError(err);
        void err;
        return null;
    }
}

export function loadConfig(cwd: string): ResolvedConfig {
    const configPath = findConfigFile(cwd);

    if (!configPath) {
        return new ResolvedConfig(new Map(), [], null);
    }

    const consumerConfig = readRawConfig(configPath);
    if (!consumerConfig) {
        return new ResolvedConfig(new Map(), [], configPath);
    }

    const overrideRules = consumerConfig.rules || {};
    const mergedRules = new Map<string, ResolvedRuleConfig>();

    const allRuleNames = new Set([
        ...Object.keys(defaultRules),
        ...Object.keys(overrideRules),
    ]);
    for (const name of allRuleNames) {
        mergedRules.set(name, mergeRule(defaultRules[name], overrideRules[name]));
    }

    const rulesDir = consumerConfig.rulesDir ?? [];

    return new ResolvedConfig(mergedRules, rulesDir, configPath);
}
