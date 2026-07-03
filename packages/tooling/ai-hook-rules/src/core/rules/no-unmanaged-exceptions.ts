import { NoUnmanagedExceptionsConfig, RULE_NAMES } from '@webpieces/rules-config';

import type { EditContext, Violation } from '../types';
import { Violation as V } from '../types';
import { EditRuleBase } from '../rule-base';
import { FixHint, Option, DisableEscape } from '../fix-hint';
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
    get fixHint(): FixHint {
        return new FixHint(
            'try/catch is generally not allowed. READ .webpieces/instruct-ai/webpieces.exceptions.md. Only chokepoints (filter, globalErrorHandler) may catch exceptions.',
            'Pick one (NOTE: for external calls — execSync, fs, network — the preferred option is almost always right; let it throw, the top-level runner reports it):',
            [
                new Option('Remove the try/catch — let the exception bubble to the top-level chokepoint (filter, globalErrorHandler) where it is already logged and handled.', true),
                new Option(
                    'If you genuinely believe this IS a chokepoint, STOP and ask the human first:\n'
                    + '  - What exception could be thrown here\n'
                    + '  - What the current top-level chokepoint is (the try/catch at the top of the call stack)\n'
                    + '  - Why throwing to that chokepoint would be wrong in this specific case\n'
                    + '  Then ask whether to remove the try/catch or add a disable comment.',
                ),
            ],
            new DisableEscape(this.config.disableAllowed ?? true, '// webpieces-disable no-unmanaged-exceptions -- <reason>'),
            true,
        );
    }

    check(ctx: EditContext): readonly Violation[] {
        const disableAllowed = this.config.disableAllowed ?? true;
        const violations: V[] = [];
        for (let i = 0; i < ctx.strippedLines.length; i += 1) {
            const stripped = ctx.strippedLines[i];
            if (!TRY_PATTERN.test(stripped)) continue;
            const lineNum = i + 1;
            if (disableAllowed && ctx.isLineDisabled(lineNum, RULE_NAMES.NO_UNMANAGED_EXCEPTIONS)) continue;
            if (disableAllowed && hasPrecedingDisable(ctx.lines, i)) continue;
            violations.push(new V(lineNum, ctx.lines[i].trim()));
        }
        if (violations.length > 0) writeTemplateIfMissing(ctx.workspaceRoot, 'webpieces.exceptions.md');
        return violations;
    }
}
