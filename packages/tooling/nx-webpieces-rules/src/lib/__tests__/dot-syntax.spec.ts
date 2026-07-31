/**
 * Tests the DOT escaping + parse-shape check.
 *
 * The regression these exist for: a service name was interpolated into a node label with bare `"`,
 * which TERMINATES the label string, so Graphviz failed with `syntax error in line 7 near '-'` and
 * the whole diagram rendered as nothing. Escaping alone would fix that one line; the assertion is
 * what makes the NEXT one a generation failure instead of a blank page.
 */

import { describe, it, expect } from 'vitest';
import { dotValue, recordValue, assertValidDot, InvalidDotError } from '../dot-syntax';

describe('dotValue', () => {
    it('escapes the quote that ends a DOT string', () => {
        expect(dotValue('helper-"fsdb"')).toBe('helper-\\"fsdb\\"');
    });

    it('escapes backslashes FIRST, so a value cannot smuggle in an escape sequence', () => {
        expect(dotValue('a\\"b')).toBe('a\\\\\\"b');
        // A value ending in a backslash must not escape the closing quote of the string it sits in.
        expect(`"${dotValue('trailing\\')}"`).toBe('"trailing\\\\"');
    });

    it('leaves ordinary label text alone — parens, spaces and dashes are not special inside quotes', () => {
        expect(dotValue('helper-svr (via svc-core)')).toBe('helper-svr (via svc-core)');
    });
});

describe('assertValidDot', () => {
    const valid =
        'digraph G {\n' +
        '  "a-svr" [fillcolor="#E8F5E9", label="a-svr\\n(server, L0, \\"a-name\\")"];\n' +
        '  "a-svr" -> "b-svr" [label="SomeApi"];\n' +
        '  label="Title";\n' +
        '}\n';

    it('accepts DOT whose interpolated values are escaped', () => {
        expect(() => assertValidDot(valid, 'test.dot')).not.toThrow();
    });

    it('rejects the exact node line the bug shipped — a bare quote around the service name', () => {
        const broken = '  "a-svr" [fillcolor="#E8F5E9", label="a-svr\\n(server, L0, "a-name")\\nimplements: X"];\n';
        expect(() => assertValidDot(broken, 'test.dot')).toThrow(InvalidDotError);
        // The message names the same line Graphviz would have failed on.
        expect(() => assertValidDot(broken, 'test.dot')).toThrow(/line 1/);
    });

    it('rejects an unterminated string', () => {
        expect(() => assertValidDot('digraph G {\n  "a" [label="oops];\n}\n', 'test.dot')).toThrow(
            /unterminated string/,
        );
    });

    it('does not trip on a value that merely CONTAINS escaped quotes or backslashes', () => {
        const dot = `digraph G {\n  "n" [label="${dotValue('a "b" c\\d')}"];\n}\n`;
        expect(() => assertValidDot(dot, 'test.dot')).not.toThrow();
    });
});

describe('recordValue', () => {
    it('escapes the record metacharacters that would RESTRUCTURE the node', () => {
        // Inside a record label these are not text: `|` splits fields and `{}` toggles the layout
        // direction, so an unescaped one splits the queue box in two or rotates it.
        expect(recordValue('a|b')).toBe('a\\|b');
        expect(recordValue('a{b}c')).toBe('a\\{b\\}c');
        expect(recordValue('a<b>c')).toBe('a\\<b\\>c');
    });

    it('still applies dotValue, so a quote cannot end the string either', () => {
        expect(recordValue('a"b')).toBe('a\\"b');
    });

    it('leaves an ordinary queue name untouched', () => {
        expect(recordValue('ReportsDispatcherApi-fireReport')).toBe('ReportsDispatcherApi-fireReport');
    });

    it('produces a record label that still passes the parse-shape check', () => {
        const dot = `digraph G {\n  "q" [shape=Mrecord, label=" |${recordValue('Api.m|x')}"];\n}\n`;
        expect(() => assertValidDot(dot, 'test.dot')).not.toThrow();
    });
});
