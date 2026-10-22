import { ScheduledTaskDto, TaskDto, TimerApi } from '@webpieces/tooling-common';

/** A task the program scheduled. The TEST decides when it runs: `run()` fires it now. */
export class MockScheduledTask extends ScheduledTaskDto {
    private ran = false;

    run(): void {
        this.ran = true;
        this.task.action();
    }

    hasRun(): boolean {
        return this.ran;
    }
}

/**
 * The feature-test {@link TimerApi}: `schedule()` CACHES the task and runs nothing; `now()` returns the
 * time the test set. A test reads {@link getScheduledTasks}, asserts each requested `delayMs`, and fires
 * the one its scenario calls for — a deadline before the command answers proves the timeout path, a
 * command that answers first proves the deadline was cancelled.
 */
export class MockTimerApi extends TimerApi {
    private readonly tasks: MockScheduledTask[] = [];
    private currentMs = 0;

    /** Pending tasks: neither cancelled nor already run, in the order they were scheduled. */
    getScheduledTasks(): MockScheduledTask[] {
        return this.tasks.filter((task: MockScheduledTask): boolean => !task.isCancelled() && !task.hasRun());
    }

    /** Every task ever scheduled, cancelled and run ones included. */
    getAllScheduledTasks(): MockScheduledTask[] {
        return [...this.tasks];
    }

    setNow(ms: number): this {
        this.currentMs = ms;
        return this;
    }

    override schedule(delayMs: number, task: TaskDto): ScheduledTaskDto {
        const scheduled = new MockScheduledTask(delayMs, task, (): void => undefined);
        this.tasks.push(scheduled);
        return scheduled;
    }

    override now(): number {
        return this.currentMs;
    }
}
