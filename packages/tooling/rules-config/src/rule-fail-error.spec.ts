import { describe, it, expect } from 'vitest';

import { RuleFailError } from './rule-fail-error';
import { InformAiError } from './inform-ai-error';

describe('RuleFailError', () => {
    it('is a standalone Error, NOT an InformAiError', () => {
        const err = new RuleFailError('no-any-unknown', 'Avoid any.');
        expect(err instanceof Error).toBe(true);
        expect(err instanceof InformAiError).toBe(false);
        expect(err.name).toBe('RuleFailError');
    });

    it('carries aiMessage into Error.message', () => {
        const err = new RuleFailError('rule-x', 'ai-facing text');
        expect(err.message).toBe('ai-facing text');
        expect(err.aiMessage).toBe('ai-facing text');
    });

    it('defaults humanMessage to aiMessage when omitted', () => {
        const err = new RuleFailError('rule-x', 'same for both');
        expect(err.humanMessage).toBe('same for both');
    });

    it('uses an explicit humanMessage when provided', () => {
        const err = new RuleFailError('rule-x', 'ai text', undefined, undefined, [], 'human/CI text');
        expect(err.aiMessage).toBe('ai text');
        expect(err.humanMessage).toBe('human/CI text');
    });

    it('defaults fixHints to an empty array and keeps line/snippet undefined', () => {
        const err = new RuleFailError('rule-x', 'msg');
        expect(err.fixHints).toEqual([]);
        expect(err.line).toBeUndefined();
        expect(err.snippet).toBeUndefined();
    });

    it('retains optional context (line, snippet, fixHints, cause)', () => {
        const cause = new Error('boom');
        const err = new RuleFailError('rule-x', 'msg', 42, 'const x: any', ['use unknown'], undefined, cause);
        expect(err.line).toBe(42);
        expect(err.snippet).toBe('const x: any');
        expect(err.fixHints).toEqual(['use unknown']);
        expect(err.cause).toBe(cause);
    });
});
