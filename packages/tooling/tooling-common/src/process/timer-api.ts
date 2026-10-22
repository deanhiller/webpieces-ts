/**
 * Work handed to the clock: what it is (for a reader of `getScheduledTasks()` in a test, and for a log)
 * and the action to run when its delay elapses. Data only.
 */
export class TaskDto {
    constructor(
        readonly description: string,
        readonly action: () => void,
    ) {}
}

/**
 * A task the clock has accepted. Data only, plus the one handle a caller needs: `cancel()`, which stops a
 * pending task from ever running (a deadline whose command finished first).
 */
export class ScheduledTaskDto {
    private cancelled = false;

    constructor(
        readonly delayMs: number,
        readonly task: TaskDto,
        private readonly onCancel: () => void,
    ) {}

    cancel(): void {
        if (this.cancelled) return;
        this.cancelled = true;
        this.onCancel();
    }

    isCancelled(): boolean {
        return this.cancelled;
    }
}

/**
 * THE clock edge (#1381). Production code never calls `setTimeout` / `setInterval` / `Date.now()` for
 * behaviour: it schedules through this, so a feature test (`MockTimerApi` in `@webpieces/tooling-testkit`)
 * sees every requested delay, and runs the scheduled work itself — no real time passes in a test.
 */
export abstract class TimerApi {
    /** Run `task` once, after `delayMs`. */
    abstract schedule(delayMs: number, task: TaskDto): ScheduledTaskDto;

    /** Milliseconds since the epoch. */
    abstract now(): number;
}
