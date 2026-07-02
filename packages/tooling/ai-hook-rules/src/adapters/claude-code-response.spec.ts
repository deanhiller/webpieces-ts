import { describe, it, expect } from 'vitest';

import { denyJson } from './claude-code-response';

const ESC = String.fromCharCode(0x1b);

// webpieces-disable no-any-unknown -- parsing our own JSON string back for assertions
interface ParsedDeny {
    systemMessage?: string;
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
        const out = parse(denyJson('nope', 'Edit'));
        expect(out.hookSpecificOutput.hookEventName).toBe('PreToolUse');
        expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
        expect(out.hookSpecificOutput.permissionDecisionReason).toBe('nope');
    });

    it('round-trips a reason containing quotes, newlines, and unicode', () => {
        const reason = '❌ blocked:\n  L5: const x = "y"\n    → use \'unknown\'';
        const out = parse(denyJson(reason, 'Bash'));
        expect(out.hookSpecificOutput.permissionDecisionReason).toBe(reason);
    });

    it('produces a single line of valid JSON (no embedded raw newline breaks parsing)', () => {
        const json = denyJson('multi\nline\nreason', 'Bash');
        expect(json.includes('\n')).toBe(false); // JSON.stringify escapes newlines inside the string
        expect(() => parse(json)).not.toThrow();
    });

    // On a Bash deny the human ONLY sees systemMessage (permissionDecisionReason is invisible), and it
    // honors ANSI — so we wrap the reason red there. permissionDecisionReason stays plain (the model
    // reads it). See the rendering matrix in claude-code-response.ts.
    it('adds an ANSI-red systemMessage on a Bash deny; keeps the reason plain', () => {
        const out = parse(denyJson('boom', 'Bash'));
        expect(out.systemMessage).toBeDefined();
        expect(out.systemMessage!.startsWith(`${ESC}[31`)).toBe(true);
        expect(out.systemMessage!.endsWith(`${ESC}[0m`)).toBe(true);
        expect(out.systemMessage).toContain('boom');
        // The reason the model reads is never ANSI-wrapped.
        expect(out.hookSpecificOutput.permissionDecisionReason).toBe('boom');
        expect(out.hookSpecificOutput.permissionDecisionReason.includes(ESC)).toBe(false);
    });

    // Write/Edit/MultiEdit render permissionDecisionReason as a red "Error:" block natively — a
    // systemMessage would just be a redundant second red line, so we omit it.
    it.each(['Write', 'Edit', 'MultiEdit'])('adds NO systemMessage on a %s deny', (tool: string) => {
        const out = parse(denyJson('boom', tool));
        expect(out.systemMessage).toBeUndefined();
        expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
        expect(out.hookSpecificOutput.permissionDecisionReason).toBe('boom');
    });
});
