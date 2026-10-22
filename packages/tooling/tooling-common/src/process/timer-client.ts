import { bindingScopeValues, injectable } from 'inversify';

import { ScheduledTaskDto, TaskDto, TimerApi } from './timer-api';

/**
 * The production {@link TimerApi}: node's own timer and clock.
 *
 * The timer is `unref()`ed: a scheduled task is a DEADLINE on other work, never a reason of its own for a
 * command-line tool to stay alive after that work is done.
 */
@injectable(bindingScopeValues.Singleton)
export class TimerClient extends TimerApi {
    override schedule(delayMs: number, task: TaskDto): ScheduledTaskDto {
        const handle = setTimeout(task.action, delayMs);
        handle.unref();
        return new ScheduledTaskDto(delayMs, task, (): void => clearTimeout(handle));
    }

    override now(): number {
        return Date.now();
    }
}
