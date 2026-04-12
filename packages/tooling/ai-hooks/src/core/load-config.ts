import * as fs from 'fs';
import * as path from 'path';

import { ResolvedConfig, ResolvedRuleConfig, RuleOptions } from './types';

// webpieces-disable no-any-unknown -- consumer JSON config has opaque rule option values
interface RawConfigFile {
    extends?: string;
    rules?: Record<string, Record<string, unknown>>;
    rulesDir?: string[];
}

export function findConfigFile(startDir: string): string | null {
    let dir = startDir;
    while (true) {
        const candidate = path.join(dir, 'webpieces.ai-hooks.json');
        if (fs.existsSync(candidate)) return candidate;
        const parent = path.dirname(dir);
        if (parent === dir) return null;
        dir = parent;
    }
}

// webpieces-disable no-any-unknown -- default config returns opaque rule option bags
function loadDefaultConfig(): Record<string, Record<string, unknown>> {
    const defaultModule = require('./configs/default');
    // webpieces-disable no-any-unknown -- opaque rule option bags
    return defaultModule.defaultRules as Record<string, Record<string, unknown>>;
}

// webpieces-disable no-any-unknown -- merging opaque option bags from config JSON
function mergeRule(
    // webpieces-disable no-any-unknown -- opaque option bag
    baseRule: Record<string, unknown> | undefined,
    // webpieces-disable no-any-unknown -- opaque option bag
    overrideRule: Record<string, unknown> | undefined,
): ResolvedRuleConfig {
    if (!baseRule && !overrideRule) return new ResolvedRuleConfig(false, {});
    if (!baseRule) return new ResolvedRuleConfig(true, overrideRule as RuleOptions);
    if (!overrideRule) {
        const enabled = baseRule['enabled'] !== false;
        return new ResolvedRuleConfig(enabled, baseRule as RuleOptions);
    }
    // webpieces-disable no-any-unknown -- building merged option bag
    const merged: Record<string, unknown> = {};
    for (const key of Object.keys(baseRule)) merged[key] = baseRule[key];
    for (const key of Object.keys(overrideRule)) merged[key] = overrideRule[key];
    const enabled = merged['enabled'] !== false;
    return new ResolvedRuleConfig(enabled, merged as RuleOptions);
}

export function loadConfig(cwd: string): ResolvedConfig {
    const configPath = findConfigFile(cwd);
    const defaultRules = loadDefaultConfig();

    if (!configPath) {
        return new ResolvedConfig(new Map(), [], null);
    }

    let consumerConfig: RawConfigFile;
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        const raw = fs.readFileSync(configPath, 'utf8');
        consumerConfig = JSON.parse(raw) as RawConfigFile;
    } catch (_err: unknown) {
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

    const baseDirs: string[] = [];
    const overrideDirs = consumerConfig.rulesDir || [];
    const rulesDir = [...baseDirs, ...overrideDirs];

    return new ResolvedConfig(mergedRules, rulesDir, configPath);
}
