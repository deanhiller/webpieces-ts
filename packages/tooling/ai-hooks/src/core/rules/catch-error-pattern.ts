import type { EditRule, EditContext, Violation } from '../types';
import { Violation as V } from '../types';

/**
 * Matches a catch clause opening: } catch (paramName: typeAnnotation) {
 * Captures: group 1 = param name, group 2 = type annotation (if present)
 */
const CATCH_PATTERN = /\bcatch\s*\(\s*(\w+)(?:\s*:\s*(\w+))?\s*\)/;

/**
 * Matches the required toError first statement (with or without comment-out).
 * Group 1 = variable name, group 2 = param passed to toError
 */
const TO_ERROR_PATTERN = /^\s*(?:\/\/\s*)?const\s+(\w+)\s*=\s*toError\(\s*(\w+)\s*\)\s*;?\s*$/;

const catchErrorPatternRule: EditRule = {
    name: 'catch-error-pattern',
    description: 'Catch blocks must use: catch (err: unknown) { const error = toError(err); }',
    scope: 'edit',
    files: ['**/*.ts', '**/*.tsx'],
    defaultOptions: {},
    fixHint: [
        'catch (err: unknown) { const error = toError(err); ... }',
        'Or to explicitly ignore: catch (err: unknown) { //const error = toError(err); }',
        'For nested catches: catch (err2: unknown) { const error2 = toError(err2); }',
        '// webpieces-disable catch-error-pattern -- <reason>',
    ],

    check(ctx: EditContext): readonly Violation[] {
        const violations: V[] = [];
        const lines = ctx.strippedLines;

        for (let i = 0; i < lines.length; i += 1) {
            const stripped = lines[i];
            const catchMatch = CATCH_PATTERN.exec(stripped);
            if (!catchMatch) continue;

            const lineNum = i + 1;
            if (ctx.isLineDisabled(lineNum, 'catch-error-pattern')) continue;

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
            const toErrorResult = findToErrorStatement(lines, i + 1);
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

        return violations;
    },
};

interface ToErrorMatch {
    varName: string;
    paramName: string;
    lineIndex: number;
}

function findToErrorStatement(lines: readonly string[], startIndex: number): ToErrorMatch | 'not-found' | 'end-of-content' {
    for (let j = startIndex; j < lines.length; j += 1) {
        const line = lines[j].trim();
        if (line === '' || line === '{') continue;

        const match = TO_ERROR_PATTERN.exec(line);
        if (match) {
            return { varName: match[1], paramName: match[2], lineIndex: j };
        }
        // First non-blank line is not a toError call
        return 'not-found';
    }
    // Ran off the end of the edit content — can't validate further
    return 'end-of-content';
}

export default catchErrorPatternRule;
