import { describe, expect, it } from 'vitest';
import * as ts from 'typescript';
import { CatchFinding, CatchPropagationAnalyzer } from './catch-propagation';
import { MIN_DISABLE_REASON } from './source-syntax';

const FORWARDS = ['error', 'warn', 'reject', 'logger.capture'];

class Judge {
    // webpieces-disable no-function-outside-class -- static factory of this spec helper
    static findings(text: string, changed?: ReadonlySet<number>): CatchFinding[] {
        const source = ts.createSourceFile('x.ts', text, ts.ScriptTarget.Latest, true);
        return new CatchPropagationAnalyzer(FORWARDS).analyze(source, changed);
    }

    // webpieces-disable no-function-outside-class -- static factory of this spec helper
    static lines(text: string): number[] {
        return Judge.findings(text).map((finding: CatchFinding) => finding.line);
    }

    /** One try/catch with `body` as the catch body, binding `err`. */
    // webpieces-disable no-function-outside-class -- static factory of this spec helper
    static catchBody(body: string, binding = '(err: unknown)'): CatchFinding[] {
        return Judge.findings(`try {\n    work();\n} catch ${binding} {\n    ${body}\n}\n`);
    }
}

describe('CatchPropagationAnalyzer — what propagates', () => {
    it.each([
        ['a rethrow', 'throw err;'],
        ['a cause', "throw new Error('decode failed', { cause: err });"],
        ['a constructor argument', "throw new ApiEndUserError('x', 'y', 400, err);"],
        ['toError + cause through a local alias', "const error = toError(err);\n    throw new Error('x', { cause: error });"],
        ['a re-typed rethrow', 'throw err as Error;'],
        ['a configured forwarder by final name', "log.warn('decode failed', err);"],
        ['a configured forwarder by dotted tail', 'this.logger.capture(err);'],
        ['a configured forwarder with the error in a field', "log.error('x', { error: err });"],
        ['reject(err)', 'reject(err);'],
        ['a return', 'return err;'],
        ['a return inside a result object', 'return { ok: false, error: toError(err) };'],
        ['a member store', 'this.lastError = toError(err);'],
        ['an element store', "state['cause'] = err;"],
        ['a store of an alias assigned later', 'let e;\n    e = err;\n    decoded.cause = e;'],
    ])('passes %s', (_label: string, body: string) => {
        expect(Judge.catchBody(body)).toEqual([]);
    });

    it('passes a .catch() callback that forwards, rethrows or returns the error', () => {
        expect(Judge.findings('p.catch((e) => log.warn(e));\n')).toEqual([]);
        expect(Judge.findings('p.catch(function (e) { throw e; });\n')).toEqual([]);
        expect(Judge.findings('p.catch((e) => e);\n')).toEqual([]);
        expect(Judge.findings('p.catch(handleError);\n')).toEqual([]);
    });
});

describe('CatchPropagationAnalyzer — what drops the error', () => {
    it.each([
        ['a message copy into a field', 'this.diagnostic = err.message;', 'only through its text'],
        ['a message in a new error with no cause', 'throw new Error(err.message);', 'only through its text'],
        ['a template', 'throw new Error(`decode failed: ${err}`);', 'only through its text'],
        ['String(err)', 'return String(err);', 'only through its text'],
        ['JSON.stringify(err)', 'throw new Error(JSON.stringify(err));', 'only through its text'],
        ['string concatenation', "log.warn('failed ' + err);", 'only through its text'],
        ['a generic throw', "throw new Error('generic');", 'never uses `err`'],
        ['an unused binding', 'return undefined;', 'never uses `err`'],
        ['a forwarder called with only the message', 'log.warn(err.message);', 'only through its text'],
        ['an unconfigured helper', 'report(err);', 'report(), which is not a configured forwarder'],
        ['an alias kept in a local only', 'const error = toError(err);\n    const keep = error;', 'keeps `err` in a local'],
        ['an instanceof test', "if (err instanceof NotFound) return null;\n    throw new Error('other');", 'only through its text'],
        ['a spread copy (message/stack are not enumerable)', 'this.saved = { ...err };', 'only through its text'],
    ])('refuses %s', (_label: string, body: string, diagnosis: string) => {
        const findings = Judge.catchBody(body);
        expect(findings).toHaveLength(1);
        expect(findings[0]!.line).toBe(3);
        expect(findings[0]!.snippet).toBe('} catch (err: unknown) {');
        expect(findings[0]!.message).toContain(diagnosis);
    });

    it('refuses a binding-less catch and a destructured binding', () => {
        expect(Judge.catchBody('return undefined;', '')[0]!.message).toContain('no error binding');
        expect(Judge.catchBody('log.warn(message);', '({ message })')[0]!.message).toContain('destructures');
    });

    it('refuses a .catch() callback with no parameter, or one that keeps only the message', () => {
        expect(Judge.findings('p.catch(() => undefined);\n')[0]!.message).toContain('no error binding');
        expect(Judge.findings('p.then(ok)\n    .catch((e) => setText(e.message));\n')).toMatchObject([{ line: 2 }]);
    });

    it('does not count a throw inside a nested callback: it runs later, on another stack', () => {
        expect(Judge.lines(
            'try {\n    work();\n} catch (err) {\n    setTimeout(() => { throw err; }, 0);\n}\n')).toEqual([3]);
    });

    it('judges nested catches independently, and a finally neither helps nor hurts', () => {
        const text = [
            'try {',
            '    work();',
            '} catch (outer) {',
            '    try {',
            '        cleanup();',
            '    } catch (inner) {',
            "        log.warn('cleanup failed', inner);",
            '    }',
            '    this.text = outer.message;',
            '} finally {',
            '    release();',
            '}',
        ].join('\n');
        expect(Judge.lines(text)).toEqual([3]);
    });
});

describe('CatchPropagationAnalyzer — scope, changed lines and the per-site disable', () => {
    const dropped = 'try {\n    work();\n} catch (err) {\n    return undefined;\n}\n';

    it('judges a catch only when a changed line falls inside its clause', () => {
        expect(Judge.findings(dropped, new Set([1, 2]))).toEqual([]);
        expect(Judge.findings(dropped, new Set([4]))).toHaveLength(1);
        expect(Judge.findings(dropped, new Set([5]))).toHaveLength(1);
    });

    it('honours a disable with a written reason on the line above or the catch line', () => {
        const above = 'try {\n    work();\n    // webpieces-disable catch-must-propagate -- a missing file is the expected first run\n} catch (err) {\n    return undefined;\n}\n';
        const trailing = 'try {\n    work();\n} catch (err) { // webpieces-disable catch-must-propagate -- a missing file is the expected first run\n    return undefined;\n}\n';
        const shared = 'try {\n    work();\n    // webpieces-disable catch-error-pattern, catch-must-propagate -- a missing file is the expected first run\n} catch (err) {\n    return undefined;\n}\n';
        expect(Judge.findings(above)).toEqual([]);
        expect(Judge.findings(trailing)).toEqual([]);
        expect(Judge.findings(shared)).toEqual([]);
    });

    it(`refuses a disable whose reason is missing or under ${MIN_DISABLE_REASON} characters`, () => {
        const bare = 'try {\n    work();\n    // webpieces-disable catch-must-propagate\n} catch (err) {\n    return undefined;\n}\n';
        const short = 'try {\n    work();\n    // webpieces-disable catch-must-propagate -- expected\n} catch (err) {\n    return undefined;\n}\n';
        expect(Judge.findings(bare)[0]!.message).toContain('needs a written reason');
        expect(Judge.findings(short)[0]!.message).toContain('needs a written reason');
    });

    it('has no block or file form: a block comment or a disable of another line exempts nothing', () => {
        const block = '/* webpieces-disable catch-must-propagate -- a missing file is the expected first run */\ntry {\n    work();\n} catch (err) {\n    return undefined;\n}\n';
        expect(Judge.lines(block)).toEqual([4]);
    });

    it('judges TypeScript sources only, never declarations or test files', () => {
        const analyzer = new CatchPropagationAnalyzer([]);
        expect(analyzer.judges('libs/a/src/service.ts')).toBe(true);
        expect(analyzer.judges('libs/a/src/view.tsx')).toBe(true);
        expect(analyzer.judges('libs/a/src/types.d.ts')).toBe(false);
        expect(analyzer.judges('libs/a/src/service.spec.ts')).toBe(false);
        expect(analyzer.judges('libs/a/src/__tests__/helper.ts')).toBe(false);
        expect(analyzer.judges('libs/a/src/legacy.js')).toBe(false);
    });

    it('an empty forwards list makes every call a non-forwarder', () => {
        const source = ts.createSourceFile('x.ts', "try { w(); } catch (err) { log.warn('x', err); }\n", ts.ScriptTarget.Latest, true);
        expect(new CatchPropagationAnalyzer([]).analyze(source)).toHaveLength(1);
    });
});
