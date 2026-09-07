import { describe, it, expect } from 'vitest';
import { CliExitError } from '@webpieces/rules-config';

import { AwaitChecksArgs, ChecksState, ChecksWaitProbe } from './await-checks-command';
import { WaitOutcome } from '../workflow/await-loop';

describe('ChecksState decides when the checks have stopped running', () => {
    it('is settled once every listed check has finished', () => {
        expect(new ChecksState(3, 0, 0, false).settled).toBe(true);
        expect(new ChecksState(3, 0, 1, false).settled).toBe(true);
    });

    it('is not settled while one is still in flight', () => {
        expect(new ChecksState(3, 1, 0, false).settled).toBe(false);
    });

    /**
     * The trap this exists to close: an EMPTY rollup seconds after a push means the workflow has not been
     * created yet — QUEUED, not "no checks". Calling that settled is how a PR gets reported green before
     * CI has started.
     */
    it('is NOT settled when GitHub has listed no checks yet', () => {
        expect(new ChecksState(0, 0, 0, false).settled).toBe(false);
        expect(new ChecksState(0, 0, 0, false).describe()).toContain('queued');
    });

    // A `gh` that cannot answer must never end the wait: announcing an outcome nobody observed is worse
    // than waiting too long.
    it('is NOT settled when gh could not be read', () => {
        expect(new ChecksState(3, 0, 0, true).settled).toBe(false);
    });

    it('describes green and red differently', () => {
        expect(new ChecksState(3, 0, 0, false).describe()).toContain('0 failed');
        expect(new ChecksState(3, 0, 2, false).describe()).toContain('2 failed');
    });
});

describe('ChecksWaitProbe reports where the checks landed', () => {
    it('names the PR and the command to re-run when it times out', () => {
        const text = new ChecksWaitProbe('874').stillWaitingReport(new WaitOutcome(false, 540_000));
        expect(text).toContain('run me again');
        expect(text).toContain('--pr 874');
    });

    it('says a timeout is not a failure, so nobody goes hunting for a broken job', () => {
        const text = new ChecksWaitProbe('874').stillWaitingReport(new WaitOutcome(false, 540_000));
        expect(text).toContain('not a failure');
    });

    it('polls slowly enough that a full wait is tens of API calls, not thousands', () => {
        expect(new ChecksWaitProbe('874').pollMs).toBeGreaterThanOrEqual(10_000);
    });
});

describe('AwaitChecksArgs requires --pr', () => {
    it('accepts a PR number', () => {
        expect(new AwaitChecksArgs().parse('874').prNumber).toBe('874');
        expect(new AwaitChecksArgs().parse(' 874 ').prNumber).toBe('874');
    });

    // Refused BEFORE the loop starts: a caller that forgot the flag must be told now, not after a
    // nine-minute wait on nothing.
    it('refuses an empty or non-numeric value, naming the flag', () => {
        for (const bad of ['', 'main', '--json']) {
            expect((): void => {
                new AwaitChecksArgs().parse(bad);
            }).toThrow(CliExitError);
        }
        expect((): void => {
            new AwaitChecksArgs().parse('');
        }).toThrow(/--pr <n>/);
    });
});
