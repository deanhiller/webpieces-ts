import type { EditRule, EditContext, Violation } from '../types';
import { Violation as V } from '../types';
import { writeTemplateIfMissing } from '../instruct-ai-writer';

const TRY_PATTERN = /\btry\s*\{/;

// Both webpieces-disable and the existing ESLint directive suppress this rule
const DISABLE_PATTERN = /@webpieces\/no-unmanaged-exceptions|webpieces-disable\s+(?:[\w-]+,\s*)*no-unmanaged-exceptions/;

const noUnmanagedExceptionsRule: EditRule = {
    name: 'no-unmanaged-exceptions',
    description: 'try/catch is generally not allowed. Only allowed in chokepoints (filter, globalErrorHandler) or other rare locations.',
    scope: 'edit',
    files: ['**/*.ts', '**/*.tsx'],
    defaultOptions: {},
    fixHint: [
        'Remove the try/catch — let the exception bubble to a chokepoint (filter, globalErrorHandler).',
        'If this IS a legitimate chokepoint, add on the line above: // webpieces-disable no-unmanaged-exceptions -- <reason>',
    ],

    check(ctx: EditContext): readonly Violation[] {
        const violations: V[] = [];
        for (let i = 0; i < ctx.strippedLines.length; i += 1) {
            const stripped = ctx.strippedLines[i];
            if (!TRY_PATTERN.test(stripped)) continue;
            const lineNum = i + 1;
            if (ctx.isLineDisabled(lineNum, 'no-unmanaged-exceptions')) continue;
            if (hasPrecedingDisable(ctx.lines, i)) continue;
            violations.push(new V(
                lineNum,
                ctx.lines[i].trim(),
                'try/catch is generally not allowed. READ .webpieces/instruct-ai/webpieces.exceptions.md to understand why. Only chokepoints (filter, globalErrorHandler) may catch exceptions.',
            ));
        }
        if (violations.length > 0) writeTemplateIfMissing(ctx.workspaceRoot, 'webpieces.exceptions.md');
        return violations;
    },
};

function hasPrecedingDisable(lines: readonly string[], idx: number): boolean {
    if (idx === 0) return false;
    const prevLine = lines[idx - 1];
    return DISABLE_PATTERN.test(prevLine);
}

export default noUnmanagedExceptionsRule;
