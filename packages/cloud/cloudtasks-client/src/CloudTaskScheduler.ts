import { inject } from 'inversify';
import { provideFrameworkSingleton } from '@webpieces/core-context';
import { RequestContext } from '@webpieces/core-context';
import { LogManager } from '@webpieces/core-util';
import { TaskInvoker, JobReference, ScheduleInfo } from './TaskTypes';
import { ScheduleFrame, setScheduleFrame, clearScheduleFrame } from './ScheduleContext';

const log = LogManager.getLogger('CloudTaskScheduler');

/**
 * Options for a scheduled task. These are QUEUE/TRANSPORT knobs (dedup, deadline)
 * that belong on the enqueue CALL, never on the shared API method — the controller
 * implementing that method has no use for them. See CloudTaskScheduler's class doc
 * for the full rationale.
 */
export class ScheduleOptions {
    /** Deterministic Cloud Task name → idempotent dedup (duplicate = ALREADY_EXISTS). */
    dedupName?: string;
    /** Per-task dispatch deadline in seconds. */
    taskTimeoutSeconds?: number;

    constructor(dedupName?: string, taskTimeoutSeconds?: number) {
        this.dedupName = dedupName;
        this.taskTimeoutSeconds = taskTimeoutSeconds;
    }
}

/**
 * Schedules Cloud Tasks. You wrap an enqueue-client call in a lambda so the shared
 * contract's method signature stays `foo(req)` on both client and controller; the
 * scheduling options ride out-of-band in the schedule frame:
 *
 *   await scheduler.addToQueue(() => taskClient.sendEmail(req), { dedupName: id });
 *   await scheduler.schedule(() => taskClient.sendEmail(req), runAtEpochMs);
 *
 * Must be called inside an active RequestContext (a server request scope).
 *
 * WHY scheduling options are here and NOT parameters on the API method
 * ------------------------------------------------------------------------
 * The enqueue client and the controller implement the SAME abstract API method
 * (`sendEmail(req): Promise<void>`). Scheduling options — `dedupName`, "run in the
 * future", `taskTimeoutSeconds` — are QUEUE/TRANSPORT concerns, not part of the
 * business contract, so they must not appear on the method signature:
 *
 *  - They are meaningless on the SERVER side. The controller's `sendEmail` just does
 *    the work (send the email). It has no use for `dedupName` (a Cloud Tasks resource
 *    name), a future run-time (Cloud Tasks already delivered it), or a dispatch
 *    deadline. Putting them on the method would force the controller to accept and
 *    ignore transport metadata it can't act on.
 *  - They vary per CALL SITE, not per method. The same `sendEmail` might be enqueued
 *    plain in one place, deduped in another, and scheduled for later in a third. That
 *    is a property of THIS enqueue, not of the API — so it belongs on the enqueue
 *    call (the scheduler), exactly like Cloud Tasks itself separates the task's
 *    schedule/dedup/deadline from the HTTP body it delivers.
 *  - Symmetry with RPC: an http-client RPC call is `foo(req)` with no transport knobs
 *    in the contract; the async (queue) client keeps that same clean contract and
 *    moves the queue knobs to the scheduler wrapper.
 *
 * So the rule is: the API method is `method(req)` on BOTH sides forever; anything
 * queue-shaped (dedup, delay, timeout, cancel) lives on CloudTaskScheduler /
 * ScheduleOptions here, never on the API.
 */
@provideFrameworkSingleton()
export class CloudTaskScheduler {
    constructor(
        @inject(TaskInvoker) private readonly invoker: TaskInvoker,
    ) {}

    /** Enqueue a task to run as soon as possible. Returns its JobReference. */
    async addToQueue(runnable: () => Promise<void>, opts?: ScheduleOptions): Promise<JobReference> {
        return this.runWithFrame(
            new ScheduleInfo(undefined, opts?.taskTimeoutSeconds, opts?.dedupName),
            runnable,
        );
    }

    /** Enqueue a task to run at an absolute epoch-millis time. Returns its JobReference. */
    async schedule(
        runnable: () => Promise<void>,
        epochMsToRunAt: number,
        opts?: ScheduleOptions,
    ): Promise<JobReference> {
        return this.runWithFrame(
            new ScheduleInfo(epochMsToRunAt, opts?.taskTimeoutSeconds, opts?.dedupName),
            runnable,
        );
    }

    /** Cancel a previously scheduled task. */
    async cancelJob(ref: JobReference): Promise<void> {
        await this.invoker.delete(ref);
    }

    private async runWithFrame(
        info: ScheduleInfo,
        runnable: () => Promise<void>,
    ): Promise<JobReference> {
        if (!RequestContext.isActive()) {
            throw new Error(
                'CloudTaskScheduler must run inside a RequestContext (a server request scope).',
            );
        }
        const frame = new ScheduleFrame(info);
        setScheduleFrame(frame);
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- always clear the frame; the runnable's error propagates unchanged
        try {
            await runnable();
        } finally {
            clearScheduleFrame();
        }
        if (!frame.jobRef) {
            throw new Error(
                'CloudTaskScheduler runnable did not enqueue a task — the lambda must call ' +
                'a task-client method exactly once.',
            );
        }
        log.debug(`scheduled task ${frame.jobRef.taskId}`);
        return frame.jobRef;
    }
}
