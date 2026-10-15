import { BaseRuleConfig, BuildPolicy, BuildPolicyResult } from '@webpieces/rules-sdk';
import { RuleFileExclusions, RuleFileScope } from '@webpieces/rules-config';

/**
 * The repo's top-level `excludePaths` (webpieces.config.json), bound at the composition root from the
 * runtime request — the globs NO rule judges, in the build as in the hooks (#1253). Data-only.
 */
export class GlobalExcludePaths {
    constructor(readonly paths: readonly string[]) {}
}

/**
 * Where code-rules APPLIES the framework-owned path exclusions (#1253): every validator the runtime
 * composes is wrapped in this, so its `run` happens inside a {@link RuleFileScope} carrying the global
 * list plus the rule's own `excludePaths`, and every file listing it asks DiffScope / ScanScope for has
 * those files removed. The validator carries no exclusion code, so a rule added to CODE_POLICIES later
 * is covered by construction. The skip check stays where it was — `shouldRun()` — and is delegated.
 */
export class ExclusionScopedPolicy implements BuildPolicy {
    readonly name: string;
    readonly configKey: string;

    constructor(
        private readonly inner: BuildPolicy,
        readonly exclusions: RuleFileExclusions,
    ) {
        this.name = inner.name;
        this.configKey = inner.configKey;
    }

    shouldRun(): boolean {
        return this.inner.shouldRun();
    }

    async run(workspaceRoot: string): Promise<BuildPolicyResult> {
        return new RuleFileScope().runWithin(this.exclusions, () => this.inner.run(workspaceRoot));
    }
}

/** Builds the exclusions of one rule run from the global list and the rule's validated config. */
export class RuleExclusionsFactory {
    forRule(ruleName: string, global: GlobalExcludePaths, config: BaseRuleConfig): RuleFileExclusions {
        return new RuleFileExclusions(ruleName, global.paths, config.excludePaths ?? []);
    }
}
