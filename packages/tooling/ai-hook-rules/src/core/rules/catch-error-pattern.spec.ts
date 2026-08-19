import { describe, it, expect } from 'vitest';

import { CatchErrorPatternConfig } from '@webpieces/rules-config';

import { EditContext } from '../types';
import { stripTsNoise } from '../strip-ts-noise';
import { createIsLineDisabled } from '../disable-directives';
import { CatchErrorPatternRule } from './catch-error-pattern';

/**
 * The context is built through the REAL stripper (`stripTsNoise`) rather than by handing the same array
 * in twice, because the bug this file guards lives exactly in the gap between the two arrays: a
 * commented-out toError line survives in `lines` and is gone from `strippedLines`. A spec that passes
 * the raw lines as both would have reported the rule healthy while it rejected its own Fix Option 2.
 */
function ctx(content: string, relativePath: string = 'src/service.ts'): EditContext {
    const stripped = stripTsNoise(content);
    return new EditContext(
        'Write', 0, 1, `/tmp/x/${relativePath}`, relativePath, '/tmp/x',
        content, stripped, content.split('\n'), stripped.split('\n'), '',
        createIsLineDisabled(content),
    );
}

function rule(): CatchErrorPatternRule {
    const cfg = new CatchErrorPatternConfig();
    cfg.mode = 'NEW_AND_MODIFIED_CODE';
    cfg.disableAllowed = true;
    return new CatchErrorPatternRule(cfg);
}

/**
 * THE REGRESSION GUARD. `check()` reads `ctx.strippedLines` to FIND catch clauses, and used to read the
 * same array looking for the toError statement — so `//const error = toError(err);` was stripped to a
 * blank line, the catch was reported as having no toError statement, and the rule refused the precise
 * cure its own FixHint advertises as Fix Option 2. 34 catches in this repo are written that way.
 */
describe('the commented-out toError escape the FixHint advertises actually passes', () => {
    it('accepts //const error = toError(err); as the first statement', () => {
        const content = [
            'class Svc {',
            '    run(): void {',
            '        try {',
            '            this.go();',
            '        } catch (err: unknown) {',
            '            //const error = toError(err);',
            '        }',
            '    }',
            '}',
        ].join('\n');
        expect(rule().check(ctx(content))).toHaveLength(0);
    });

    it('accepts the spaced form // const error = toError(err);', () => {
        const content = [
            '} catch (err: unknown) {',
            '    // const error = toError(err);',
            '}',
        ].join('\n');
        expect(rule().check(ctx(content))).toHaveLength(0);
    });

    it('accepts the nested numbering, commented out', () => {
        const content = [
            '} catch (err2: unknown) {',
            '    //const error2 = toError(err2);',
            '}',
        ].join('\n');
        expect(rule().check(ctx(content))).toHaveLength(0);
    });

    // The escape is not a blanket amnesty: the commented form still has to NAME the right variable and
    // the right parameter, or it is a line somebody copied without reading.
    it('still rejects a commented form whose variable name is wrong', () => {
        const content = [
            '} catch (err: unknown) {',
            '    //const e = toError(err);',
            '}',
        ].join('\n');
        const violations = rule().check(ctx(content));
        expect(violations).toHaveLength(1);
        expect(violations[0].message).toContain('must be named "error"');
    });
});

describe('the live toError statement is unaffected by reading the raw line first', () => {
    it('accepts the ordinary form', () => {
        const content = [
            '} catch (err: unknown) {',
            '    const error = toError(err);',
            '    this.log(error);',
            '}',
        ].join('\n');
        expect(rule().check(ctx(content))).toHaveLength(0);
    });

    // Raw is tested FIRST, so this is the case that proves testing it first cannot break the live form:
    // the trailing comment makes the raw line fail TO_ERROR_PATTERN's `$` anchor, and the stripped line
    // then matches. Both arrays are consulted, in that order, for exactly this reason.
    it('accepts a live toError carrying a trailing comment', () => {
        const content = [
            '} catch (err: unknown) {',
            '    const error = toError(err); // why we care',
            '}',
        ].join('\n');
        expect(rule().check(ctx(content))).toHaveLength(0);
    });

    it('skips an unrelated comment line before the toError statement', () => {
        const content = [
            '} catch (err: unknown) {',
            '    // the network is allowed to be down',
            '    const error = toError(err);',
            '}',
        ].join('\n');
        expect(rule().check(ctx(content))).toHaveLength(0);
    });

    it('still reports a catch whose first statement is not toError at all', () => {
        const content = [
            '} catch (err: unknown) {',
            '    this.log(err);',
            '}',
        ].join('\n');
        const violations = rule().check(ctx(content));
        expect(violations).toHaveLength(1);
        expect(violations[0].message).toContain('must call toError(err)');
    });
});
