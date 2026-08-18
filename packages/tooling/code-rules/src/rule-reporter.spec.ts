import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RuleFailError, Option } from '@webpieces/rules-config';

import { RuleReporter } from './rule-reporter';
import { RuleRun, ExecutorResult } from './code-validator';

const reporter = new RuleReporter();

// Minimal run: RuleReporter only reads `name` and calls `run()`.
function fakeRun(name: string, run: () => Promise<ExecutorResult>): RuleRun {
    return new RuleRun(name, run);
}

describe('RuleReporter.runValidators (per-run isolation)', () => {
    beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => undefined); });
    afterEach(() => { vi.restoreAllMocks(); });

    it('runs EVERY run even when an earlier one throws (no abort)', async () => {
        const ran: string[] = [];
        const runs = [
            fakeRun('throws-rulefail', () => { ran.push('throws-rulefail'); throw new RuleFailError('throws-rulefail', 'bad'); }),
            fakeRun('crashes', () => { ran.push('crashes'); throw new Error('boom'); }),
            fakeRun('passes', () => { ran.push('passes'); return Promise.resolve({ success: true }); }),
        ];
        const result = await reporter.runValidators(runs);
        expect(ran).toEqual(['throws-rulefail', 'crashes', 'passes']); // all ran, in order
        expect(result.success).toBe(false); // a throw marks the run failed
    });

    it('reports a thrown RuleFailError with its humanMessage', async () => {
        const spy = vi.spyOn(console, 'error');
        const err = new RuleFailError('no-any', 'ai text', 7, 'x: any', [new Option('use unknown')], 'HUMAN CI text');
        await reporter.runValidators([fakeRun('no-any', () => { throw err; })]);
        const printed = spy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
        expect(printed).toContain('[no-any]');
        expect(printed).toContain('HUMAN CI text');
        expect(printed).toContain('Fix Option 1: use unknown');
    });

    it('reports a plain-Error bug as a validator crash', async () => {
        const spy = vi.spyOn(console, 'error');
        await reporter.runValidators([fakeRun('buggy', () => { throw new Error('kaboom'); })]);
        const printed = spy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
        expect(printed).toContain("Validator 'buggy' crashed: kaboom");
    });

    it('renders the preferred cure first-class, with the framework-owned label', async () => {
        const spy = vi.spyOn(console, 'error');
        const err = new RuleFailError('r', 'ai text', undefined, undefined,
            [new Option('the right way', true), new Option('the other way')]);
        await reporter.runValidators([fakeRun('r', () => { throw err; })]);
        const printed = spy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
        expect(printed).toContain('Fix Option 1: (preferred) the right way');
        expect(printed).toContain('Fix Option 2: the other way');
    });

    it('honors a legacy run that returns {success:false} (back-compat shim, pending deletion)', async () => {
        const result = await reporter.runValidators([
            fakeRun('legacy-fail', () => Promise.resolve({ success: false })),
            fakeRun('ok', () => Promise.resolve({ success: true })),
        ]);
        expect(result.success).toBe(false);
    });

    it('succeeds when every run passes', async () => {
        const result = await reporter.runValidators([
            fakeRun('a', () => Promise.resolve({ success: true })),
            fakeRun('b', () => Promise.resolve({ success: true })),
        ]);
        expect(result.success).toBe(true);
    });
});
