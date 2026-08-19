import { CatchErrorPatternConfig, RULE_NAMES, Option } from '@webpieces/rules-config';

import type { EditContext, Violation } from '../types';
import { Violation as V } from '../types';
import { EditRuleBase } from '../rule-base';
import { FixHint, DisableEscape } from '../fix-hint';
import { writeTemplateIfMissing } from '../instruct-ai-writer';

/**
 * Matches a catch clause opening: } catch (paramName: typeAnnotation) {
 * Captures: group 1 = param name, group 2 = type annotation (if present)
 */
const CATCH_PATTERN = /\bcatch\s*\(\s*(\w+)(?:\s*:\s*(\w+))?\s*\)/;

/**
 * Matches the required toError first statement (with or without comment-out).
 * Group 1 = variable name, group 2 = param passed to toError
 *
 * The optional `//` prefix is what makes Fix Option 2 — "to explicitly ignore the error, write
 * `//const error = toError(err);`" — a real escape. It is only reachable when the pattern is tested
 * against the RAW source line; see findToErrorStatement() for why both line arrays are needed.
 */
const TO_ERROR_PATTERN = /^\s*(?:\/\/\s*)?const\s+(\w+)\s*=\s*toError\(\s*(\w+)\s*\)\s*;?\s*$/;

/**
 * What `stripTsNoise` leaves behind where a `//` comment was: the two slashes, then blanks to the end of
 * the line. Trimming a stripped comment line therefore yields `//`, not `''`. See findToErrorStatement().
 */
const COMMENT_REMNANT = /\/\/\s*$/;

interface ToErrorMatch {
    varName: string;
    paramName: string;
    lineIndex: number;
}

export class CatchErrorPatternRule extends EditRuleBase<CatchErrorPatternConfig> {
    constructor(config: CatchErrorPatternConfig) { super(config, 'catch-error-pattern', 'catch-error-pattern'); }

    readonly description = 'Catch blocks must use: catch (err: unknown) { const error = toError(err); }'; // webpieces-disable catch-error-pattern -- example text in a description string
    override readonly files = ['**/*.ts', '**/*.tsx'];
    get fixHint(): FixHint {
        return new FixHint(
            'Catch block does not follow the toError(err) pattern.',
            'Name the catch parameter err (err2/err3 when nested), then pick one:',
            [
                new Option('Add as the first statement in the catch block: const error = toError(err);', true),
                new Option('To explicitly ignore the error: //const error = toError(err);'),
            ],
            new DisableEscape(this.config.disableAllowed ?? true, '// webpieces-disable catch-error-pattern -- <reason>'), // webpieces-disable catch-error-pattern -- example text in a hint string
        );
    }

    check(ctx: EditContext): readonly Violation[] {
        const disableAllowed = this.config.disableAllowed ?? true;
        const violations: V[] = [];
        const lines = ctx.strippedLines;

        for (let i = 0; i < lines.length; i += 1) {
            const stripped = lines[i];
            const catchMatch = CATCH_PATTERN.exec(stripped);
            if (!catchMatch) continue;

            const lineNum = i + 1;
            if (disableAllowed && ctx.isLineDisabled(lineNum, RULE_NAMES.CATCH_ERROR_PATTERN)) continue;

            const actualParam = catchMatch[1];
            const typeAnnotation = catchMatch[2];

            // Determine expected names from suffix on the actual param (err, err2, err3...)
            const suffixMatch = actualParam.match(/^err(\d*)$/);
            const suffix = suffixMatch ? suffixMatch[1] : '';
            const expectedParam = 'err' + suffix;
            const expectedVar = 'error' + suffix;

            // Check parameter name
            if (actualParam !== expectedParam) {
                violations.push(new V(
                    lineNum,
                    ctx.lines[i].trim(),
                    `Catch parameter must be named "${expectedParam}" (or "err2", "err3" for nested catches), got "${actualParam}"`,
                ));
            }

            // Check type annotation is unknown
            if (typeAnnotation !== 'unknown') {
                const msg = typeAnnotation
                    ? `Catch parameter must be typed as "unknown": catch (${expectedParam}: unknown), got "${typeAnnotation}"`
                    : `Catch parameter must be typed as "unknown": catch (${expectedParam}: unknown)`;
                violations.push(new V(lineNum, ctx.lines[i].trim(), msg));
            }

            // Find next non-blank line after the catch opening to check for toError
            const toErrorResult = this.findToErrorStatement(ctx, i + 1);
            if (toErrorResult === 'not-found') {
                violations.push(new V(
                    lineNum,
                    ctx.lines[i].trim(),
                    `Catch block must call toError(${actualParam}) as first statement: const ${expectedVar} = toError(${actualParam}); or //const ${expectedVar} = toError(${actualParam});`,
                ));
            } else if (toErrorResult !== 'end-of-content') {
                // Validate variable name and param match
                if (toErrorResult.varName !== expectedVar) {
                    const toErrorLineNum = toErrorResult.lineIndex + 1;
                    violations.push(new V(
                        toErrorLineNum,
                        ctx.lines[toErrorResult.lineIndex].trim(),
                        `Error variable must be named "${expectedVar}", got "${toErrorResult.varName}"`,
                    ));
                }
                if (toErrorResult.paramName !== actualParam) {
                    const toErrorLineNum = toErrorResult.lineIndex + 1;
                    violations.push(new V(
                        toErrorLineNum,
                        ctx.lines[toErrorResult.lineIndex].trim(),
                        `toError() must be called with "${actualParam}", got "${toErrorResult.paramName}"`,
                    ));
                }
            }
        }
        if (violations.length > 0) writeTemplateIfMissing(ctx.workspaceRoot, 'webpieces.exceptions.md');
        return violations;
    }

    /**
     * The first statement of the catch block, judged against BOTH line arrays — and that pairing is the
     * whole fix for a bug that made this rule refuse the exact cure it prescribes.
     *
     * The rule FINDS catch clauses in `ctx.strippedLines`, which is right: a `catch (e) {` inside a
     * comment is not a catch clause. But it used to also LOOK FOR the toError statement there, and
     * stripping deletes `//const error = toError(err);` down to an empty line — so Fix Option 2, the
     * documented way to say "this error is deliberately ignored", was reported as "no toError statement"
     * every single time. TO_ERROR_PATTERN's optional `//` prefix could never match, because nothing
     * carrying a `//` ever reached it. 34 catches in this repo already use that form.
     *
     * So: the RAW line decides whether the commented form is present, and the STRIPPED line decides what
     * counts as "the first statement" (a blank line, a `{`, or an unrelated comment is skipped past).
     * Raw is tested first because it is the only array in which the comment form survives; a live
     * statement with a trailing comment (`const error = toError(err); // why`) fails the raw test on the
     * `$` anchor and is then matched on its stripped form, which is exactly the intent.
     *
     * COMMENT_REMNANT is the other half of that, and it is a property of the stripper: `stripTsNoise`
     * KEEPS the `//` marker and blanks only what follows it, so a stripped comment line trims to `//`
     * rather than to the empty string. Without normalizing that away, `//` is neither blank nor a `{`,
     * so it was taken for the first statement — which is the mechanical reason a commented-out toError
     * reported "no toError statement", and the reason a trailing `// why` on a LIVE toError reported the
     * same. One replace fixes both, in the one place the question is asked.
     */
    private findToErrorStatement(ctx: EditContext, startIndex: number): ToErrorMatch | 'not-found' | 'end-of-content' {
        const stripped = ctx.strippedLines;
        for (let j = startIndex; j < stripped.length; j += 1) {
            const rawMatch = TO_ERROR_PATTERN.exec((ctx.lines[j] ?? '').trim());
            if (rawMatch) return { varName: rawMatch[1], paramName: rawMatch[2], lineIndex: j };

            const line = stripped[j].replace(COMMENT_REMNANT, '').trim();
            // Blank, an opening brace, or a comment that stripping emptied — none of these is the first
            // statement, so keep looking.
            if (line === '' || line === '{') continue;

            const match = TO_ERROR_PATTERN.exec(line);
            if (match) return { varName: match[1], paramName: match[2], lineIndex: j };
            // First real statement is not a toError call
            return 'not-found';
        }
        // Ran off the end of the edit content — can't validate further
        return 'end-of-content';
    }
}
