import { describe, it, expect } from 'vitest';

import { AwaitLoop, CEILING_MS, HEARTBEAT_MS, WaitHeartbeat, WaitOutcome, WaitProbe } from './await-loop';
import { GateLogFile } from './gate-log-file';
import { StageOutputLog } from './stage-output-log';

/** Captures what the loop printed, so the heartbeat can be asserted on without a terminal. */
class RecordingConsole extends StageOutputLog {
    readonly said: string[] = [];

    constructor() {
        super(new GateLogFile());
    }

    say(text: string): void {
        this.said.push(text);
    }
}

/** A probe that finishes after N polls, so a whole wait runs in milliseconds. */
class CountdownProbe implements WaitProbe {
    readonly label = 'reviewers';
    readonly pollMs = 1;
    calls = 0;

    constructor(private readonly finishAfter: number) {}

    done(): boolean {
        this.calls++;
        return this.calls > this.finishAfter;
    }

    describe(): string {
        return `${String(this.calls)} of 4 verdicts in`;
    }
}

describe('AwaitLoop blocks until the probe is done', () => {
    it('returns immediately, and prints nothing, when the wait is already over', async () => {
        const console_ = new RecordingConsole();
        const outcome = await new AwaitLoop(console_).run(new CountdownProbe(0));
        expect(outcome.done).toBe(true);
        expect(console_.said).toEqual([]);
    });

    it('polls until the probe says done, then reports done', async () => {
        const probe = new CountdownProbe(5);
        const outcome = await new AwaitLoop(new RecordingConsole()).run(probe);
        expect(outcome.done).toBe(true);
        expect(probe.calls).toBe(6);
    });

    /**
     * The harness backgrounds and KILLS a foreground command silent for 600 seconds, so the very first
     * thing a wait must do is prove it is alive — before any sleep, not after one.
     */
    it('prints a heartbeat before the first sleep', async () => {
        const console_ = new RecordingConsole();
        await new AwaitLoop(console_).run(new CountdownProbe(2));
        expect(console_.said[0]).toContain('waiting on reviewers');
        expect(console_.said[0]).toContain('verdicts in');
    });
});

describe('AwaitLoop timing constants keep it under the harness ceiling', () => {
    // Not style: the harness kills at 600s. A ceiling at or above that means the command is killed
    // holding its answer instead of returning it, which is the whole failure this exists to avoid.
    it('gives up comfortably before the 600-second watchdog', () => {
        expect(CEILING_MS).toBeLessThan(600_000);
        expect(CEILING_MS).toBeGreaterThan(60_000);
    });

    it('heartbeats far more often than the watchdog needs', () => {
        expect(HEARTBEAT_MS).toBeLessThanOrEqual(20_000);
    });
});

describe('WaitHeartbeat says `still` only when nothing moved', () => {
    it('omits still on the first tick and on a changed state', () => {
        const beat = new WaitHeartbeat('reviewers');
        expect(beat.tick('1 of 4 verdicts in', 0)).not.toContain('still');
        expect(beat.tick('2 of 4 verdicts in', 20_000)).not.toContain('still');
    });

    /**
     * `still` is the load-bearing word, exactly as in BuildLogHeartbeat: without it, a wait where
     * nothing has happened for two minutes and a wait whose REPORTER has died read identically.
     */
    it('says still when the state repeats', () => {
        const beat = new WaitHeartbeat('reviewers');
        beat.tick('2 of 4 verdicts in', 0);
        expect(beat.tick('2 of 4 verdicts in', 20_000)).toContain('still');
    });

    it('reports elapsed seconds, so a reader can see the wait growing', () => {
        expect(new WaitHeartbeat('CI checks').tick('queued', 45_000)).toContain('(45s)');
    });

    it('consumes a heartbeat slot, so one elapsed window prints one line', () => {
        const beat = new WaitHeartbeat('reviewers');
        expect(beat.isDue(HEARTBEAT_MS - 1)).toBe(false);
        expect(beat.isDue(HEARTBEAT_MS)).toBe(true);
        expect(beat.isDue(HEARTBEAT_MS)).toBe(false);
        expect(beat.isDue(HEARTBEAT_MS * 2)).toBe(true);
    });
});

describe('WaitOutcome', () => {
    it('rounds the wait to whole seconds in one place, so no message formats it twice', () => {
        expect(new WaitOutcome(true, 45_400).waitedSeconds).toBe(45);
    });
});
