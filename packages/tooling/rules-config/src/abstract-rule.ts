import { BaseRuleConfig } from './rule-configs';
import { shouldSkipRule } from './skip-rule';

/**
 * Shared base for every rule in BOTH packages (ai-hook-rules and code-rules). A rule is
 * constructed with its typed config (`new NoAnyUnknownRule(config['no-any-unknown'])`), so the
 * config class is genuinely consumed — find-usages/rename work across packages.
 *
 * It is execution-agnostic: it owns only `name` + the on/off + escape-hatch decision
 * (`shouldRun`). Each package's base adds its own execution surface (ai-hook `check(ctx)`,
 * code-rules `run(workspaceRoot)`), so rules-config stays free of package-specific types.
 */
export abstract class AbstractRule<C extends BaseRuleConfig> {
    constructor(protected readonly config: C, readonly name: string) {}

    /** True unless the rule is `mode: "OFF"` or skipped by a branch/epoch escape hatch. */
    shouldRun(): boolean {
        if (this.config.mode === 'OFF') return false;
        const skip = shouldSkipRule(this.config.ignoreModifiedUntilEpoch, this.config.ignoreRuleWhileOnBranch);
        return !skip.skip;
    }
}
