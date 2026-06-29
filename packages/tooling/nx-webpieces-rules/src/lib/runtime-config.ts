/**
 * Runtime Config
 *
 * Loads the `runtime-architecture` rule from webpieces.config.json and exposes
 * typed accessors shared by the generate + validate + visualize executors.
 *
 *   "runtime-architecture": {
 *     "mode": "ON",                          // "OFF" disables the whole feature
 *     "apiProjectPaths": ["libraries/apis/*"],
 *     "ignoreModifiedUntilEpoch": 0,         // whole-rule punt (epoch seconds)
 *     "allowedCycles": [ { "services": ["a","b"], "reason": "...", "until": 1771931925 } ]
 *   }
 */

import { loadAndValidate, shouldSkipRule, SkipRuleResult } from '@webpieces/rules-config';

export const RUNTIME_RULE_NAME = 'runtime-architecture';

export interface AllowedCycle {
    services: string[];
    reason?: string;
    until?: number;
}

export interface RuntimeRuleConfig {
    off: boolean;
    apiProjectPaths: string[];
    servicePaths: string[];
    ignoreModifiedUntilEpoch?: number;
    ignoreRuleWhileOnBranch?: string;
    allowedCycles: AllowedCycle[];
}

/**
 * Typed view of the opaque webpieces.config.json option bag for this rule. The
 * config is trusted (it is the workspace's own file), so we cast once here and
 * defensively narrow arrays/numbers rather than threading `unknown` everywhere.
 */
interface RuntimeRuleRaw {
    apiProjectPaths?: string[];
    servicePaths?: string[];
    ignoreModifiedUntilEpoch?: number;
    ignoreRuleWhileOnBranch?: string;
    allowedCycles?: AllowedCycle[];
}

function isUsableCycle(cycle: AllowedCycle): boolean {
    return Array.isArray(cycle.services) && cycle.services.length > 0;
}

/** Load the runtime-architecture rule config (with safe defaults). */
export function loadRuntimeConfig(workspaceRoot: string): RuntimeRuleConfig {
    const shared = loadAndValidate(workspaceRoot).resolved;
    const rule = shared.rules.get(RUNTIME_RULE_NAME);
    const raw = (rule?.options ?? {}) as RuntimeRuleRaw;
    return {
        off: rule?.isOff ?? false,
        apiProjectPaths: Array.isArray(raw.apiProjectPaths) ? raw.apiProjectPaths : [],
        servicePaths: Array.isArray(raw.servicePaths) ? raw.servicePaths : [],
        ignoreModifiedUntilEpoch:
            typeof raw.ignoreModifiedUntilEpoch === 'number' ? raw.ignoreModifiedUntilEpoch : undefined,
        ignoreRuleWhileOnBranch:
            typeof raw.ignoreRuleWhileOnBranch === 'string' ? raw.ignoreRuleWhileOnBranch : undefined,
        allowedCycles: Array.isArray(raw.allowedCycles) ? raw.allowedCycles.filter(isUsableCycle) : [],
    };
}

/**
 * Whole-rule report-only window honoring BOTH escape hatches: skip while on the
 * named branch (ignoreRuleWhileOnBranch) or until the epoch passes
 * (ignoreModifiedUntilEpoch). When `.skip` is true, problems are reported but
 * the build is not failed.
 */
export function runtimeReportOnly(config: RuntimeRuleConfig): SkipRuleResult {
    return shouldSkipRule(config.ignoreModifiedUntilEpoch, config.ignoreRuleWhileOnBranch);
}

/**
 * Whole-rule grace window: while now < epoch, failures are reported but do not
 * fail the build (warn). Mirrors the other webpieces rules.
 */
export function isGraceActive(epoch: number | undefined): boolean {
    if (epoch === undefined) return false;
    return Date.now() / 1000 < epoch;
}

/** Format the epoch as an ISO date for log messages. */
export function epochDate(epoch: number): string {
    return new Date(epoch * 1000).toISOString().split('T')[0];
}
