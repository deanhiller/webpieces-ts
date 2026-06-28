import type { EditRule, EditContext, Violation } from '../types';
import { Violation as V } from '../types';
import { writeTemplateIfMissing } from '../instruct-ai-writer';

/**
 * Matches: throw new SomeClass(
 */
const THROW_NEW_PATTERN = /\bthrow\s+new\s+\w+\s*\(/;

/**
 * Matches: error.message or error2.message or error3.message
 */
const ERROR_MESSAGE_PATTERN = /\berror\d*\.message\b/;

/**
 * Matches: cause: error or cause: error2 etc. (the good pattern)
 */
const CAUSE_PATTERN = /\bcause\s*:\s*error\d*\b/;

const throwCauseRequiredRule: EditRule = {
    name: 'throw-cause-required',
    description: 'When rethrowing with added context, chain the original exception: throw new Error("msg", { cause: error })',
    scope: 'edit',
    files: ['**/*.ts', '**/*.tsx'],
    defaultOptions: {},
    configSchema: {},
    fixHint: [
        'Option 1 — Remove the try-catch entirely. Letting the original exception bubble is usually the best option.',
        'Option 2 — throw new Error("add more info here", { cause: error }); chains the error and preserves the full stack trace.',
        'Option 3 — throw new SpecificError("add info here", { cause: error }); e.g. new InformAiError("what happened for AI", { cause: error }).',
        '[Only if disableAllowed:true] Option 4 — // webpieces-disable throw-cause-required -- <reason>',
    ],

    check(ctx: EditContext): readonly Violation[] {
        const violations: V[] = [];
        const lines = ctx.strippedLines;

        for (let i = 0; i < lines.length; i += 1) {
            const stripped = lines[i];
            if (!THROW_NEW_PATTERN.test(stripped)) continue;
            if (!ERROR_MESSAGE_PATTERN.test(stripped)) continue;
            if (CAUSE_PATTERN.test(stripped)) continue;

            const lineNum = i + 1;
            if (ctx.isLineDisabled(lineNum, 'throw-cause-required')) continue;

            violations.push(new V(
                lineNum,
                ctx.lines[i].trim(),
                'Rethrowing with error.message loses the original stack trace. Use { cause: error } to chain it.',
            ));
        }

        if (violations.length > 0) writeTemplateIfMissing(ctx.workspaceRoot, 'webpieces.exceptions.md');
        return violations;
    },
};

export default throwCauseRequiredRule;
