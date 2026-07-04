import { describe, it, expect } from 'vitest';
import {
    MatchRuleConfig,
    findMatchRuleViolations,
    renderMatchRuleMessage,
    DEFAULT_MATCH_RULES,
} from './match-rules-config';

// The real seeded no-fetch guard — exercises the actual shipped patterns + allowedPaths.
const NO_FETCH = DEFAULT_MATCH_RULES[0]!;

function linesOf(src: string): string[] {
    return src.split('\n');
}

describe('findMatchRuleViolations (no-fetch guard)', () => {
    it('flags a raw global fetch( call', () => {
        const v = findMatchRuleViolations(linesOf("const r = await fetch('https://x');"), 'src/foo.ts', NO_FETCH);
        expect(v).toHaveLength(1);
        expect(v[0]!.line).toBe(1);
    });

    it('flags axios, XMLHttpRequest, new Request(, and node-fetch imports', () => {
        expect(findMatchRuleViolations(linesOf('const c = axios.get(url);'), 'src/a.ts', NO_FETCH)).toHaveLength(1);
        expect(findMatchRuleViolations(linesOf('const x = new XMLHttpRequest();'), 'src/a.ts', NO_FETCH)).toHaveLength(1);
        expect(findMatchRuleViolations(linesOf('const req = new Request(url);'), 'src/a.ts', NO_FETCH)).toHaveLength(1);
        expect(findMatchRuleViolations(linesOf("import fetch from 'node-fetch';"), 'src/a.ts', NO_FETCH)).toHaveLength(1);
    });

    it('does NOT flag member-access fetch (this.fetch(, client.fetch(, prefetch(, fetchValue()', () => {
        const src = [
            'this.fetch(url);',
            'client.fetch(url);',
            'prefetch(url);',
            'const v = svc.fetchValue(req);',
        ].join('\n');
        expect(findMatchRuleViolations(linesOf(src), 'src/a.ts', NO_FETCH)).toHaveLength(0);
    });

    it('does NOT flag the generated-client path (createApiClient)', () => {
        const src = "const client = createApiClient(SaveApi, new ClientConfig('https://host'));";
        expect(findMatchRuleViolations(linesOf(src), 'src/a.ts', NO_FETCH)).toHaveLength(0);
    });

    it('exempts allowlisted paths (the client factory) and test files', () => {
        const src = "const r = await fetch(input);";
        expect(findMatchRuleViolations(linesOf(src), 'packages/http/http-client/src/ClientFactory.ts', NO_FETCH)).toHaveLength(0);
        expect(findMatchRuleViolations(linesOf(src), 'libraries/apis-external/src/Impl.ts', NO_FETCH)).toHaveLength(0);
        expect(findMatchRuleViolations(linesOf(src), 'src/foo.spec.ts', NO_FETCH)).toHaveLength(0);
        expect(findMatchRuleViolations(linesOf(src), 'src/__tests__/foo.ts', NO_FETCH)).toHaveLength(0);
    });

    it('reports at most one violation per line (first matching pattern wins)', () => {
        // fetch( and axios on the same line → still one violation for that line.
        const v = findMatchRuleViolations(linesOf('await fetch(url); axios.get(url);'), 'src/a.ts', NO_FETCH);
        expect(v).toHaveLength(1);
    });
});

describe('renderMatchRuleMessage', () => {
    it('renders the main message, numbered options, and the disable escape', () => {
        const cfg = new MatchRuleConfig('no-moment', ['\\bmoment\\b'], 'Use date-fns instead.', 'NEW_AND_MODIFIED_CODE', 0, ['Use date-fns', 'Use Temporal'], true, []);
        const msg = renderMatchRuleMessage(cfg);
        expect(msg).toContain('Use date-fns instead.');
        expect(msg).toContain('Fix Option 1: Use date-fns');
        expect(msg).toContain('Fix Option 2: Use Temporal');
        expect(msg).toContain('// webpieces-disable no-moment -- <reason>');
    });

    it('omits the disable escape when disableAllowed is false', () => {
        const cfg = new MatchRuleConfig('no-moment', ['\\bmoment\\b'], 'Use date-fns.', 'NEW_AND_MODIFIED_CODE', 0, [], false, []);
        expect(renderMatchRuleMessage(cfg)).not.toContain('webpieces-disable');
    });
});
