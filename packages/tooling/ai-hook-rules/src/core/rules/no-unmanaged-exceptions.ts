import { NoUnmanagedExceptionsConfig, RULE_NAMES } from '@webpieces/rules-config';

import type { EditContext, Violation } from '../types';
import { Violation as V } from '../types';
import { EditRuleBase } from '../rule-base';
import { writeTemplateIfMissing } from '../instruct-ai-writer';

const TRY_PATTERN = /\btry\s*\{/;

// Both webpieces-disable and the existing ESLint directive suppress this rule
const DISABLE_PATTERN = /@webpieces\/no-unmanaged-exceptions|webpieces-disable\s+(?:[\w-]+,\s*)*no-unmanaged-exceptions/;

function hasPrecedingDisable(lines: readonly string[], idx: number): boolean {
    if (idx === 0) return false;
    const prevLine = lines[idx - 1];
    return DISABLE_PATTERN.test(prevLine);
}

export class NoUnmanagedExceptionsRule extends EditRuleBase<NoUnmanagedExceptionsConfig> {
    constructor(config: NoUnmanagedExceptionsConfig) { super(config, 'no-unmanaged-exceptions'); }

    readonly description = 'try/catch is generally not allowed. Only allowed in chokepoints (filter, globalErrorHandler) or other rare locations.';
    override readonly files = ['**/*.ts', '**/*.tsx'];
    readonly fixHint = [
        'Fix Option 1 (preferred): Remove the try/catch — let the exception bubble to the top-level chokepoint (filter, globalErrorHandler) where it is already logged and handled.',
        'Fix Option 2 (ask the human first): If you genuinely believe this IS a chokepoint, STOP and tell the human:',
        '  - What exception could be thrown here',
        '  - What the current top-level chokepoint is (the try/catch at the top of the call stack)',
        '  - Why throwing to that chokepoint would be wrong in this specific case',
        '  Then ask: "Should I add a disable comment or remove the try/catch?"',
        '  Only add // webpieces-disable no-unmanaged-exceptions -- <reason> if the human says yes.',
        'NOTE: If the code is calling an external process (execSync, fs, network), the correct answer is almost always Option 1 — let it throw. Hooks have a top-level runner that reports errors properly.',
    ];

    check(ctx: EditContext): readonly Violation[] {
        const violations: V[] = [];
        for (let i = 0; i < ctx.strippedLines.length; i += 1) {
            const stripped = ctx.strippedLines[i];
            if (!TRY_PATTERN.test(stripped)) continue;
            const lineNum = i + 1;
            if (ctx.isLineDisabled(lineNum, RULE_NAMES.NO_UNMANAGED_EXCEPTIONS)) continue;
            if (hasPrecedingDisable(ctx.lines, i)) continue;
            violations.push(new V(
                lineNum,
                ctx.lines[i].trim(),
                'try/catch is generally not allowed. READ .webpieces/instruct-ai/webpieces.exceptions.md to understand why. Only chokepoints (filter, globalErrorHandler) may catch exceptions.',
            ));
        }
        if (violations.length > 0) writeTemplateIfMissing(ctx.workspaceRoot, 'webpieces.exceptions.md');
        return violations;
    }
}
