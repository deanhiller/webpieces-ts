import type { EditRule, EditContext, Violation } from '../types';
import { Violation as V } from '../types';

const TRY_PATTERN = /\btry\s*\{/;

// Both our own directive AND the existing ESLint directive suppress this rule
const ESLINT_DIRECTIVE = /@webpieces\/no-unmanaged-exceptions/;

const noUnmanagedExceptionsRule: EditRule = {
    name: 'no-unmanaged-exceptions',
    description: 'try/catch is generally not allowed. Only allowed in chokepoints (filter, globalErrorHandler) or other rare locations.',
    scope: 'edit',
    files: ['**/*.ts', '**/*.tsx'],
    defaultOptions: {},
    fixHint: [
        'Exceptions should bubble to a chokepoint (filter in node.js, globalErrorHandler in Angular). Most code should NOT catch exceptions.',
        '// eslint-disable-next-line @webpieces/no-unmanaged-exceptions  (also suppresses the eslint rule)',
    ],

    check(ctx: EditContext): readonly Violation[] {
        const violations: V[] = [];
        for (let i = 0; i < ctx.strippedLines.length; i += 1) {
            const stripped = ctx.strippedLines[i];
            if (!TRY_PATTERN.test(stripped)) continue;
            const lineNum = i + 1;
            if (ctx.isLineDisabled(lineNum, 'no-unmanaged-exceptions')) continue;
            if (hasPrecedingEslintDisable(ctx.lines, i)) continue;
            violations.push(new V(
                lineNum,
                ctx.lines[i].trim(),
                'try/catch is generally not allowed. It is only allowed in chokepoints (filter, globalErrorHandler) or other rare locations.',
            ));
        }
        return violations;
    },
};

function hasPrecedingEslintDisable(lines: readonly string[], idx: number): boolean {
    if (idx === 0) return false;
    const prevLine = lines[idx - 1];
    return ESLINT_DIRECTIVE.test(prevLine);
}

export default noUnmanagedExceptionsRule;
