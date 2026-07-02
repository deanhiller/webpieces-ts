import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RuleFailError, BaseRuleConfig } from '@webpieces/rules-config';

import { runValidators } from './rule-reporter';
import { CodeValidator, ExecutorResult } from './code-validator';

// Minimal fake validator: runValidators only reads `name` and calls `run(root)`.
function fakeValidator(name: string, run: () => Promise<ExecutorResult>): CodeValidator<BaseRuleConfig> {
    return { name, run } as unknown as CodeValidator<BaseRuleConfig>;
}

describe('runValidators (per-validator isolation)', () => {
    beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => undefined); });
    afterEach(() => { vi.restoreAllMocks(); });

    it('runs EVERY validator even when an earlier one throws (no abort)', async () => {
        const ran: string[] = [];
        const validators = [
            fakeValidator('throws-rulefail', () => { ran.push('throws-rulefail'); throw new RuleFailError('throws-rulefail', 'bad'); }),
            fakeValidator('crashes', () => { ran.push('crashes'); throw new Error('boom'); }),
            fakeValidator('passes', () => { ran.push('passes'); return Promise.resolve({ success: true }); }),
        ];
        const result = await runValidators(validators, '/root');
        expect(ran).toEqual(['throws-rulefail', 'crashes', 'passes']); // all ran, in order
        expect(result.success).toBe(false); // a throw marks the run failed
    });

    it('reports a thrown RuleFailError with its humanMessage', async () => {
        const spy = vi.spyOn(console, 'error');
        const err = new RuleFailError('no-any', 'ai text', 7, 'x: any', ['use unknown'], 'HUMAN CI text');
        await runValidators([fakeValidator('no-any', () => { throw err; })], '/root');
        const printed = spy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
        expect(printed).toContain('[no-any]');
        expect(printed).toContain('HUMAN CI text');
        expect(printed).toContain('Fix: use unknown');
    });

    it('reports a plain-Error bug as a validator crash', async () => {
        const spy = vi.spyOn(console, 'error');
        await runValidators([fakeValidator('buggy', () => { throw new Error('kaboom'); })], '/root');
        const printed = spy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
        expect(printed).toContain("Validator 'buggy' crashed: kaboom");
    });

    it('honors a legacy validator that returns {success:false} (back-compat)', async () => {
        const result = await runValidators([
            fakeValidator('legacy-fail', () => Promise.resolve({ success: false })),
            fakeValidator('ok', () => Promise.resolve({ success: true })),
        ], '/root');
        expect(result.success).toBe(false);
    });

    it('succeeds when every validator passes', async () => {
        const result = await runValidators([
            fakeValidator('a', () => Promise.resolve({ success: true })),
            fakeValidator('b', () => Promise.resolve({ success: true })),
        ], '/root');
        expect(result.success).toBe(true);
    });
});
