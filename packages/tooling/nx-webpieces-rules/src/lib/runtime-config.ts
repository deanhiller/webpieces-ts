/**
 * Runtime Config
 *
 * Loads the `runtime-architecture` rule from webpieces.config.json and exposes
 * typed accessors shared by the generate + validate + visualize executors.
 *
 *   "runtime-architecture": {
 *     "mode": "ON",                          // "OFF" disables the whole feature
 *     "turnOffRuleUntilEpoch": 0,            // whole-rule punt (epoch seconds)
 *     "turnOffRuleWhileOnBranch": null,      // whole-rule punt while on a named branch
 *     "showExternalNodes": true,              // draw firestore/gmail/... as terminal nodes
 *     "externalApiPaths": ["libraries/apis/external/**"]  // where those vendor contracts live
 *   }
 */

import { loadAndValidate, shouldSkipRule, SkipRuleResult } from '@webpieces/rules-config';

export const RUNTIME_RULE_NAME = 'runtime-architecture';

export interface RuntimeRuleConfig {
    off: boolean;
    turnOffRuleUntilEpoch?: number;
    turnOffRuleWhileOnBranch?: string;
    /** Render the dashed external terminal nodes in the runtime viz (default true). */
    showExternalNodes: boolean;
    /**
     * Globs of project roots whose exported `*Api` types are contracts for systems OUTSIDE this repo.
     * Empty (the default) means the scan looks for no vendor seams at all.
     */
    externalApiPaths: string[];
}

/**
 * Typed view of the opaque webpieces.config.json option bag for this rule. The
 * config is trusted (it is the workspace's own file), so we cast once here and
 * defensively narrow arrays/numbers rather than threading `unknown` everywhere.
 */
interface RuntimeRuleRaw {
    turnOffRuleUntilEpoch?: number;
    turnOffRuleWhileOnBranch?: string | null;
    showExternalNodes?: boolean;
    externalApiPaths?: string[];
}

/** Load the runtime-architecture rule config (with safe defaults). */
export function loadRuntimeConfig(workspaceRoot: string): RuntimeRuleConfig {
    const shared = loadAndValidate(workspaceRoot).resolved;
    const rule = shared.rules.get(RUNTIME_RULE_NAME);
    const raw = (rule?.options ?? {}) as RuntimeRuleRaw;
    return {
        off: rule?.isOff ?? false,
        turnOffRuleUntilEpoch:
            typeof raw.turnOffRuleUntilEpoch === 'number' ? raw.turnOffRuleUntilEpoch : undefined,
        // turnOffRuleWhileOnBranch is required-but-NULLABLE in the config ("null" = always on), so a
        // non-string (null) collapses to undefined, which shouldSkipRule treats as "no branch scoping".
        turnOffRuleWhileOnBranch:
            typeof raw.turnOffRuleWhileOnBranch === 'string' ? raw.turnOffRuleWhileOnBranch : undefined,
        // Opt-OUT: the external systems are the ones that page you at 3am, so they are drawn unless
        // a repo explicitly says its external surface is too noisy to be useful.
        showExternalNodes: raw.showExternalNodes !== false,
        // Opt-IN: there is no safe guess for where a repo keeps its vendor wrappers, and guessing
        // wrong would classify ordinary libraries as systems outside the repo.
        externalApiPaths: Array.isArray(raw.externalApiPaths)
            ? raw.externalApiPaths.filter((entry: string) => typeof entry === 'string' && entry.length > 0)
            : [],
    };
}

/**
 * Whole-rule report-only window honoring BOTH escape hatches: skip while on the
 * named branch (turnOffRuleWhileOnBranch) or until the epoch passes
 * (turnOffRuleUntilEpoch). When `.skip` is true, problems are reported but
 * the build is not failed.
 */
export function runtimeReportOnly(config: RuntimeRuleConfig): SkipRuleResult {
    return shouldSkipRule(config.turnOffRuleUntilEpoch, config.turnOffRuleWhileOnBranch);
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
