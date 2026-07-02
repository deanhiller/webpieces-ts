import { describe, it, expect } from 'vitest';

import { denyJson } from './claude-code-response';

// webpieces-disable no-any-unknown -- parsing our own JSON string back for assertions
interface ParsedDeny {
    hookSpecificOutput: {
        hookEventName: string;
        permissionDecision: string;
        permissionDecisionReason: string;
    };
}

function parse(json: string): ParsedDeny {
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    return JSON.parse(json) as ParsedDeny;
}

describe('denyJson', () => {
    it('emits the PreToolUse deny shape Claude Code expects', () => {
        const out = parse(denyJson('nope'));
        expect(out.hookSpecificOutput.hookEventName).toBe('PreToolUse');
        expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
        expect(out.hookSpecificOutput.permissionDecisionReason).toBe('nope');
    });

    it('round-trips a reason containing quotes, newlines, and unicode', () => {
        const reason = '❌ blocked:\n  L5: const x = "y"\n    → use \'unknown\'';
        const out = parse(denyJson(reason));
        expect(out.hookSpecificOutput.permissionDecisionReason).toBe(reason);
    });

    it('produces a single line of valid JSON (no embedded raw newline breaks parsing)', () => {
        const json = denyJson('multi\nline\nreason');
        expect(json.includes('\n')).toBe(false); // JSON.stringify escapes newlines inside the string
        expect(() => parse(json)).not.toThrow();
    });
});
