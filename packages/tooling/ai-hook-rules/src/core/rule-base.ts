import { AbstractRule, BaseRuleConfig, RuleOptions } from '@webpieces/rules-config';

import type { EditContext, BashContext, FileContext, Violation, Rule } from './types';

/**
 * A concrete, instantiable BaseRuleConfig used as a fallback when a built-in rule has no
 * entry in webpieces.config.json yet. It carries no values, so the rule's `description`,
 * `fixHint`, and `defaultOptions` (which are config-independent) are still readable for the
 * out-of-sync report — the rule never actually runs in that state (the sync check blocks first).
 */
export class EmptyRuleConfig extends BaseRuleConfig {}

/**
 * Scope-specific base for edit rules. Extends the shared AbstractRule (which owns `name`,
 * the typed `config`, and `shouldRun()`), and adds the ai-hook execution surface.
 */
export abstract class EditRuleBase<C extends BaseRuleConfig> extends AbstractRule<C> implements Rule {
    readonly scope = 'edit' as const;
    readonly files: readonly string[] = [];
    readonly defaultOptions: RuleOptions = {};
    abstract readonly description: string;
    abstract readonly fixHint: readonly string[];

    abstract check(ctx: EditContext): readonly Violation[];
}

export abstract class FileRuleBase<C extends BaseRuleConfig> extends AbstractRule<C> implements Rule {
    readonly scope = 'file' as const;
    readonly files: readonly string[] = [];
    readonly defaultOptions: RuleOptions = {};
    abstract readonly description: string;
    abstract readonly fixHint: readonly string[];

    abstract check(ctx: FileContext): readonly Violation[];
}

export abstract class BashRuleBase<C extends BaseRuleConfig> extends AbstractRule<C> implements Rule {
    readonly scope = 'bash' as const;
    readonly files: readonly string[] = [];
    readonly defaultOptions: RuleOptions = {};
    abstract readonly description: string;
    abstract readonly fixHint: readonly string[];

    abstract check(ctx: BashContext): readonly Violation[];
}
