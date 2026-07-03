import { RequireReturnTypeConfig, RULE_NAMES } from '@webpieces/rules-config';

import type { EditContext, Violation } from '../types';
import { Violation as V } from '../types';
import { EditRuleBase } from '../rule-base';
import { FixHint, DisableEscape } from '../fix-hint';

// Matches function/method signatures that don't have `: ReturnType` before the `{` body opener.
// Pattern: function name(<params>) { — missing `: Type` between `)` and `{`
const FUNC_DECL_MISSING = /\bfunction\s+\w+\s*(?:<[^>]*>)?\s*\([^)]*\)\s*\{/;

// Matches class method signatures: indented, optional async, name(<params>) {
const METHOD_MISSING = /^\s{2,}(?:async\s+)?\w+\s*(?:<[^>]*>)?\s*\([^)]*\)\s*\{/;

// Arrow function: const name = (async)? (<params>) => — missing `: Type` before `=>`
const ARROW_MISSING = /\bconst\s+\w+\s*=\s*(?:async\s+)?(?:<[^>]*>)?\s*\([^)]*\)\s*=>/;

// Lines that have ): ReturnType before { or => — these are COMPLIANT
const HAS_RETURN_TYPE = /\)\s*:\s*\S/;

// Skip constructors, getters, setters, and control flow keywords
const SKIP_PATTERN = /\b(?:constructor|get\s+\w+|set\s+\w+|if|else|while|for|switch|catch|return)\s*\(/;

function isMissingReturnType(line: string): boolean {
    if (SKIP_PATTERN.test(line)) return false;
    const isFuncLike =
        FUNC_DECL_MISSING.test(line) ||
        METHOD_MISSING.test(line) ||
        ARROW_MISSING.test(line);
    if (!isFuncLike) return false;
    if (HAS_RETURN_TYPE.test(line)) return false;
    return true;
}

export class RequireReturnTypeRule extends EditRuleBase<RequireReturnTypeConfig> {
    constructor(config: RequireReturnTypeConfig) { super(config, 'require-return-type'); }

    readonly description = 'Every function and method must declare its return type.';
    override readonly files = ['**/*.ts', '**/*.tsx'];
    get fixHint(): FixHint {
        return new FixHint(
            'Missing return type annotation.',
            'Add a return type: function foo(x: T): ReturnType { ... }.',
            [],
            new DisableEscape(this.config.disableAllowed ?? true, '// webpieces-disable require-return-type -- <reason>'),
        );
    }

    check(ctx: EditContext): readonly Violation[] {
        const disableAllowed = this.config.disableAllowed ?? true;
        const violations: V[] = [];
        for (let i = 0; i < ctx.strippedLines.length; i += 1) {
            const stripped = ctx.strippedLines[i];
            if (!isMissingReturnType(stripped)) continue;
            const lineNum = i + 1;
            if (disableAllowed && ctx.isLineDisabled(lineNum, RULE_NAMES.REQUIRE_RETURN_TYPE)) continue;
            violations.push(new V(lineNum, ctx.lines[i].trim()));
        }
        return violations;
    }
}
