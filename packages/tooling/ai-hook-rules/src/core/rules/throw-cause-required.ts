import { ThrowCauseRequiredConfig, RULE_NAMES } from '@webpieces/rules-config';

import type { EditContext, Violation } from '../types';
import { Violation as V } from '../types';
import { EditRuleBase } from '../rule-base';
import { FixHint, Option, DisableEscape } from '../fix-hint';
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

export class ThrowCauseRequiredRule extends EditRuleBase<ThrowCauseRequiredConfig> {
    constructor(config: ThrowCauseRequiredConfig) { super(config, 'throw-cause-required'); }

    readonly description = 'When rethrowing with added context, chain the original exception: throw new Error("msg", { cause: error })';
    override readonly files = ['**/*.ts', '**/*.tsx'];
    get fixHint(): FixHint {
        return new FixHint(
            'Rethrowing with error.message loses the original stack trace. Use { cause: error } to chain it.',
            'Pick one:',
            [
                new Option('Remove the try-catch entirely. Letting the original exception bubble is usually the best option.', true),
                new Option('throw new Error("add more info here", { cause: error }); chains the error and preserves the full stack trace.'),
                new Option('throw new SpecificError("add info here", { cause: error }); e.g. new InformAiError("what happened for AI", { cause: error }).'),
            ],
            new DisableEscape(this.config.disableAllowed ?? true, '// webpieces-disable throw-cause-required -- <reason>'),
            true,
        );
    }

    check(ctx: EditContext): readonly Violation[] {
        const disableAllowed = this.config.disableAllowed ?? true;
        const violations: V[] = [];
        const lines = ctx.strippedLines;

        for (let i = 0; i < lines.length; i += 1) {
            const stripped = lines[i];
            if (!THROW_NEW_PATTERN.test(stripped)) continue;
            if (!ERROR_MESSAGE_PATTERN.test(stripped)) continue;
            if (CAUSE_PATTERN.test(stripped)) continue;

            const lineNum = i + 1;
            if (disableAllowed && ctx.isLineDisabled(lineNum, RULE_NAMES.THROW_CAUSE_REQUIRED)) continue;

            violations.push(new V(lineNum, ctx.lines[i].trim()));
        }

        if (violations.length > 0) writeTemplateIfMissing(ctx.workspaceRoot, 'webpieces.exceptions.md');
        return violations;
    }
}
