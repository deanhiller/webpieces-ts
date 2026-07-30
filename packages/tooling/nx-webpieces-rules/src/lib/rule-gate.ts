/**
 * Config gate for the Nx infrastructure validators.
 *
 * Every other rule in the system (eslint rules, code-rules, ai-hook rules, validate-ts-in-src) can be
 * turned off or time-boxed from webpieces.config.json. The five infrastructure executors
 * (validate-architecture-unchanged, validate-no-architecture-cycles, validate-packagejson,
 * validate-versions-locked, validate-eslint-sync) hardcoded their behavior instead, which made them
 * the only checks a consuming repo could not adopt gradually. This gate gives them the same
 * semantics, from the same source of truth (`loadAndValidate` → webpieces.config.json).
 *
 * Semantics:
 *  - rule entry ABSENT (or no webpieces.config.json at all) → RUN. Fail-safe: an older config, or a
 *    repo that has not adopted the keys yet, behaves exactly as it did before this gate existed.
 *  - `"mode": "OFF"` → skip with a reason.
 *  - the time-box / branch escape hatches (turnOffRuleUntilEpoch / turnOffRuleWhileOnBranch, and their
 *    ignoreModifiedUntilEpoch / ignoreRuleWhileOnBranch aliases) → honored when the caller passes
 *    `honorEpoch: true`. All five executors now pass true: a schedule ("do not enforce until <epoch>
 *    / off <branch>") is coherent for any of them, baseline or not (see the comment block above
 *    ValidateArchitectureUnchangedConfig in rules-config/src/rule-configs.ts). The param is retained
 *    so a future caller can still opt a rule out of time-boxing. loadAndValidate has already
 *    canonicalized the new field names onto the ignore* pair, so this reads only the originals.
 */

import { loadAndValidate, shouldSkipRule } from '@webpieces/rules-config';

export class RuleGate {
    /**
     * @param workspaceRoot the Nx `context.root` — where webpieces.config.json is looked up from.
     * @param ruleName the webpieces.config.json key, identical to the Nx target name.
     * @param honorEpoch true to honor the time-box/branch escape hatches (all five executors pass true).
     * @returns a human-readable reason when the executor must SKIP, or null when it must RUN.
     */
    skipReason(workspaceRoot: string, ruleName: string, honorEpoch: boolean): string | null {
        const rule = loadAndValidate(workspaceRoot).resolved.rules.get(ruleName);
        // Absent ⇒ run. Never invent a default that silently disables a check.
        if (!rule) return null;
        if (rule.isOff) return 'mode: OFF';
        if (!honorEpoch) return null;

        const epoch = rule.options['ignoreModifiedUntilEpoch'] as number | undefined;
        const branch = rule.options['ignoreRuleWhileOnBranch'] as string | undefined;
        const skip = shouldSkipRule(epoch, branch);
        return skip.skip ? (skip.reason ?? 'temporarily disabled') : null;
    }

    /**
     * Convenience wrapper: prints the standard skip line and reports whether the caller should stop.
     * Keeps the four-line preamble identical across all five executors.
     */
    isDisabled(workspaceRoot: string, ruleName: string, honorEpoch: boolean): boolean {
        const reason = this.skipReason(workspaceRoot, ruleName, honorEpoch);
        if (reason === null) return false;
        console.log(`\n⏭️  Skipping ${ruleName} (${reason}) — configured in webpieces.config.json\n`);
        return true;
    }
}
