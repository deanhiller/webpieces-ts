import { AbstractRule, BaseRuleConfig, RuleOptions } from '@webpieces/rules-config';

import type {
    PlainRule, Rule, RuleScope,
    EditContext, FileContext, BashContext, Violation,
} from './types';

/**
 * Wraps a custom rule loaded from a `rulesDir` (a plain object) so it satisfies the same
 * runtime `Rule` contract as the built-in rule classes: it gains `shouldRun()` (driven by the
 * rule's config entry in webpieces.config.json) from AbstractRule, and it seeds `ctx.options`
 * with the merged option bag before delegating to the plain rule's `check()` — preserving the
 * exact behavior custom rules had under the old options-based runner.
 */
export class CustomRuleAdapter extends AbstractRule<BaseRuleConfig> implements Rule {
    readonly scope: RuleScope;
    readonly files: readonly string[];
    readonly description: string;
    readonly fixHint: readonly string[];
    readonly defaultOptions: RuleOptions;
    private readonly impl: PlainRule;
    private readonly rawConfig: RuleOptions;

    constructor(impl: PlainRule, rawConfig: RuleOptions) {
        super(rawConfig as BaseRuleConfig, impl.name);
        this.impl = impl;
        this.scope = impl.scope;
        this.files = impl.files;
        this.description = impl.description;
        this.fixHint = impl.fixHint;
        this.defaultOptions = impl.defaultOptions;
        this.rawConfig = rawConfig;
    }

    private buildOptions(): RuleOptions {
        const out: RuleOptions = {};
        for (const key of Object.keys(this.defaultOptions)) out[key] = this.defaultOptions[key];
        for (const key of Object.keys(this.rawConfig)) {
            // 'mode' is the framework-level on/off switch, not a rule option.
            if (key === 'mode') continue;
            out[key] = this.rawConfig[key];
        }
        return out;
    }

    check(ctx: EditContext | FileContext | BashContext): readonly Violation[] {
        ctx.options = this.buildOptions();
        return this.impl.check(ctx);
    }
}
