import type { EditRule, EditContext, Violation } from '../types';
import { Violation as V } from '../types';

const ANY_PATTERN =
    /(?::\s*any\b|\bas\s+any\b|<any>|any\[\]|Array<any>|Promise<any>|Map<[^,<>]+,\s*any\s*>|Record<[^,<>]+,\s*any\s*>|Set<any>)/;

const noAnyRule: EditRule = {
    name: 'no-any-unknown',
    description: 'Disallow the `any` keyword. Use concrete types or interfaces.',
    scope: 'edit',
    files: ['**/*.ts', '**/*.tsx'],
    defaultOptions: {},
    fixHint: [
        'Prefer: interface MyData { ... }   or   class MyData { ... }',
        '// webpieces-disable no-any-unknown -- <one-line reason>',
    ],

    check(ctx: EditContext): readonly Violation[] {
        const violations: V[] = [];
        for (let i = 0; i < ctx.strippedLines.length; i += 1) {
            const stripped = ctx.strippedLines[i];
            if (!ANY_PATTERN.test(stripped)) continue;
            const lineNum = i + 1;
            if (ctx.isLineDisabled(lineNum, 'no-any-unknown')) continue;
            violations.push(new V(
                lineNum,
                ctx.lines[i].trim(),
                '`any` erases type information. Use a concrete type, an interface, or `unknown` with type guards.',
            ));
        }
        return violations;
    },
};

export default noAnyRule;
