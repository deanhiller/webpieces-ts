import { MatchRuleConfig, findMatchRuleViolations, Option } from '@webpieces/rules-config';

import type { EditContext, Violation } from '../types';
import { Violation as V } from '../types';
import { EditRuleBase } from '../rule-base';
import { FixHint, DisableEscape } from '../fix-hint';

/**
 * A single client-authored content guard from the `match-rules` array. Unlike the framework's
 * keyed rules, its regexes and message live entirely in webpieces.config.json — one MatchRule is
 * instantiated per array entry (see loadMatchRules). `name` doubles as the disable token.
 */
export class MatchRule extends EditRuleBase<MatchRuleConfig> {
    // A match-rule is its OWN key: it lives in the `match-rules` array, not in `rules`/`hookGuards`,
    // so name and configKey are the same string here and always will be. Passed explicitly all the
    // same — there is no defaulted spelling of this decision anywhere.
    constructor(config: MatchRuleConfig) { super(config, config.name, config.name); }

    override readonly files = ['**/*.ts', '**/*.tsx'];

    get description(): string {
        return `Content guard "${this.config.name}" — flags configured regex patterns that bypass this project's conventions.`;
    }

    get fixHint(): FixHint {
        const c = this.config;
        return new FixHint(
            `${c.name}: matched a disallowed pattern.`,
            c.mainMessage,
            (c.options ?? []).map((o: string) => new Option(o)),
            new DisableEscape(c.disableAllowed ?? true, `// webpieces-disable ${c.name} -- <reason>`),
        );
    }

    check(ctx: EditContext): readonly Violation[] {
        const c = this.config;
        const disableAllowed = c.disableAllowed ?? true;
        const violations: V[] = [];
        for (const hit of findMatchRuleViolations(ctx.lines, ctx.relativePath, c)) {
            if (disableAllowed && ctx.isLineDisabled(hit.line, c.name)) continue;
            violations.push(new V(hit.line, hit.context));
        }
        return violations;
    }
}
