import { NoAnyUnknownConfig, RULE_NAMES } from '@webpieces/rules-config';

import type { EditContext, Violation } from '../types';
import { Violation as V } from '../types';
import { EditRuleBase } from '../rule-base';

// This regex literal matches the token as text, not a TS type.
const ANY_PATTERN =
    /(?::\s*any\b|\bas\s+any\b|<any>|any\[\]|Array<any>|Promise<any>|Map<[^,<>]+,\s*any\s*>|Record<[^,<>]+,\s*any\s*>|Set<any>)/; // webpieces-disable no-any-unknown -- regex literal, not a type

export class NoAnyUnknownRule extends EditRuleBase<NoAnyUnknownConfig> {
    constructor(config: NoAnyUnknownConfig) { super(config, 'no-any-unknown'); }

    readonly description = 'Disallow the `any` keyword. Use concrete types or interfaces.';
    override readonly files = ['**/*.ts', '**/*.tsx'];
    readonly fixHint = [
        'Prefer: interface MyData { ... }   or   class MyData { ... }',
        '// webpieces-disable no-any-unknown -- <one-line reason>',
    ];

    check(ctx: EditContext): readonly Violation[] {
        const violations: V[] = [];
        for (let i = 0; i < ctx.strippedLines.length; i += 1) {
            const stripped = ctx.strippedLines[i];
            if (!ANY_PATTERN.test(stripped)) continue;
            const lineNum = i + 1;
            if (ctx.isLineDisabled(lineNum, RULE_NAMES.NO_ANY_UNKNOWN)) continue;
            violations.push(new V(
                lineNum,
                ctx.lines[i].trim(),
                '`any` erases type information. Use a concrete type, an interface, or `unknown` with type guards.',
            ));
        }
        return violations;
    }
}
