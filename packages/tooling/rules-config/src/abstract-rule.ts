import { BaseRuleConfig } from './rule-configs';
import { shouldSkipRule } from './skip-rule';

/**
 * Shared base for every rule in BOTH packages (ai-hook-rules and code-rules). A rule is
 * constructed with its typed config (`new NoAnyUnknownRule(config['no-any-unknown'])`), so the
 * config class is genuinely consumed — find-usages/rename work across packages.
 *
 * It is execution-agnostic: it owns only `name` + `configKey` + the on/off + escape-hatch decision
 * (`shouldRun`). Each package's base adds its own execution surface (ai-hook `check(ctx)`,
 * code-rules `run(workspaceRoot)`), so rules-config stays free of package-specific types.
 *
 * ## `name` and `configKey` are two different identities, and they are BOTH required
 *
 * `name` is the OPERATOR identity: it is what a decision-log line carries as `rule=`, what a deny
 * report titles itself with, and what prose in `guards/**` names when it describes behaviour. It is
 * per-CLASS and it never changes when the config collapses.
 *
 * `configKey` is the webpieces.config.json KEY whose entry configures this rule. Several classes may
 * share one key when they implement one POLICY — the four branch-state guards all read
 * `branch-state-guard`, the four PR-lifecycle guards all read `pr-lifecycle-guard` — because a
 * consumer switches a POLICY on and off, not an implementation class. Half a policy (`read-stale-guard`
 * OFF while `merged-branch-bash-guard` stays ON: read the file, yes; `cat` the same file, no) was
 * representable while the two were the same string, and this split is what makes it unrepresentable.
 *
 * BOTH are constructor params with NO default. A `configKey = name` default would make the common
 * case silent and the shared case a thing you have to remember — which is the same "widening that is
 * an ABSENCE rather than a token" `.claude/rules/no-backwards-compat.md` rejects. Every rule says which
 * key configures it, out loud,
 * so `grep "'branch-state-guard'"` lists every class that key governs.
 */
export abstract class AbstractRule<C extends BaseRuleConfig> {
    constructor(protected readonly config: C, readonly name: string, readonly configKey: string) {}

    /** True unless the rule is `mode: "OFF"` or skipped by a branch/epoch escape hatch. */
    shouldRun(): boolean {
        if (this.config.mode === 'OFF') return false;
        const skip = shouldSkipRule(this.config.turnOffRuleUntilEpoch, this.config.turnOffRuleWhileOnBranch);
        return !skip.skip;
    }
}
