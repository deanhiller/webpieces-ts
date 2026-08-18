import { describe, it, expect } from 'vitest';

import { RuleFailError, renderRuleFailForAi, renderRuleFailForHuman } from './rule-fail-error';
import { Option } from './fix-option';
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

    it('defaults fixOptions to an empty array and keeps line/snippet undefined', () => {
        const err = new RuleFailError('rule-x', 'msg');
        expect(err.fixOptions).toEqual([]);
        expect(err.line).toBeUndefined();
        expect(err.snippet).toBeUndefined();
    });

    it('retains optional context (line, snippet, fixOptions, cause)', () => {
        const cause = new Error('boom');
        const err = new RuleFailError('rule-x', 'msg', 42, 'const x: any', [new Option('use unknown')], undefined, cause);
        expect(err.line).toBe(42);
        expect(err.snippet).toBe('const x: any');
        expect(err.fixOptions).toEqual([new Option('use unknown')]);
        expect(err.cause).toBe(cause);
    });

    // The whole point of moving Option down into this package: a BUILD-time throw can now say which
    // cure to reach for first, which `readonly string[]` could not express at all.
    it('carries the preferred flag on a cure, exactly like FixHint does', () => {
        const err = new RuleFailError('rule-x', 'msg', undefined, undefined,
            [new Option('do the right thing', true), new Option('the other way')]);
        expect(err.fixOptions[0]?.preferred).toBe(true);
        expect(err.fixOptions[1]?.preferred).toBe(false);
    });
});

// The top-level handlers (code-rules cli.ts / wp-ci.ts, ai-hook-rules hook-core.ts /
// openclaw-plugin.ts) all render through these, so a cure can never be dropped by whichever catch
// happens to catch the throw.
describe('renderRuleFailFor* — the audience renderings', () => {
    it('returns the bare message when there are no cures', () => {
        const err = new RuleFailError('r', 'ai text', undefined, undefined, [], 'human text');
        expect(renderRuleFailForAi(err)).toBe('ai text');
        expect(renderRuleFailForHuman(err)).toBe('human text');
    });

    it('appends the cures, framework-numbered, with the preferred tag surviving to the output', () => {
        const err = new RuleFailError('r', 'ai text', undefined, undefined,
            [new Option('do this first', true), new Option('or this')], 'human text');
        expect(renderRuleFailForAi(err)).toBe(
            'ai text\n  Fix Option 1: (preferred) do this first\n  Fix Option 2: or this');
        expect(renderRuleFailForHuman(err)).toBe(
            'human text\n  Fix Option 1: (preferred) do this first\n  Fix Option 2: or this');
    });

    it('falls back to aiMessage for the human audience when humanMessage was not given', () => {
        const err = new RuleFailError('r', 'only one message', undefined, undefined, [new Option('c')]);
        expect(renderRuleFailForHuman(err)).toBe('only one message\n  Fix Option 1: c');
    });
});
