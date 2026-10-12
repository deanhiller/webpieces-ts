import { inject } from 'inversify';
import { provideFrameworkSingleton } from '@webpieces/core-context';
import { RequestContext } from '@webpieces/core-context';
import { LogManager } from '@webpieces/core-util';
import type { CallOptions } from 'google-gax';
import { TaskInvoker, JobReference, ScheduleInfo, TaskCustomizer } from './TaskTypes';
import { TaskName } from './TaskName';
import { ScheduleFrame, setScheduleFrame, clearScheduleFrame } from './ScheduleContext';

const log = LogManager.getLogger('CloudTaskScheduler');

/**
 * Options for a scheduled task. These are QUEUE/TRANSPORT knobs (naming, deadline, the Google
 * request, gax) that belong on the enqueue CALL, never on the shared API method — the controller
 * implementing that method has no use for them. See CloudTaskScheduler's class doc for the full
 * rationale.
 *
 * Three levels, three owners:
 * - the `CloudTasksClient` (via an overridden `CloudTasksClientProvider`): the channel and client
 *   defaults (keepalive, endpoint, clientConfig);
 * - `gax` here, or `GcpTaskRegistry.setGax(...)`: how the ONE `createTask` RPC of this enqueue
 *   behaves. Set ⇒ YOU own timing: no webpieces retries, one attempt, under a safety cap;
 * - `customizeTask` here, or `GcpTaskRegistry.setCustomizer(...)`: the Google request itself.
 */
export class ScheduleOptions {
    constructor(
        /** How the task is named. Default: one generated UUID per logical enqueue, reused on retry. */
        readonly taskName: TaskName = TaskName.generated(),
        /** Per-task dispatch deadline in seconds (`task.dispatchDeadline`). */
        readonly taskTimeoutSeconds?: number,
        /** Changes the Google request on every attempt; NEVER gax. See {@link TaskCustomizer}. */
        readonly customizeTask?: TaskCustomizer,
        /** gax `CallOptions` for `createTask`. Set ⇒ you own timing/retries for this enqueue. */
        readonly gax?: CallOptions,
    ) {}
}

/**
 * Schedules Cloud Tasks. You wrap an enqueue-client call in a lambda so the shared
 * contract's method signature stays `foo(req)` on both client and controller; the
 * scheduling options ride out-of-band in the schedule frame:
 *
 *   await scheduler.addToQueue(() => taskClient.sendEmail(req));
 *   await scheduler.addToQueue(() => taskClient.sendEmail(req), new ScheduleOptions(TaskName.dedup(id), 900));
 *   await scheduler.schedule(() => taskClient.sendEmail(req), runAtEpochMs);
 *
 * Must be called inside an active RequestContext (a server request scope).
 *
 * WHY scheduling options are here and NOT parameters on the API method
 * ------------------------------------------------------------------------
 * The enqueue client and the controller implement the SAME abstract API method
 * (`sendEmail(req): Promise<void>`). Scheduling options — the task name, "run in the
 * future", `taskTimeoutSeconds` — are QUEUE/TRANSPORT concerns, not part of the
 * business contract, so they must not appear on the method signature:
 *
 *  - They are meaningless on the SERVER side. The controller's `sendEmail` just does
 *    the work (send the email). It has no use for a task name (a Cloud Tasks resource
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
            this.infoFor(undefined, opts),
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
            this.infoFor(epochMsToRunAt, opts),
            runnable,
        );
    }

    /** Cancel a previously scheduled task. */
    async cancelJob(ref: JobReference): Promise<void> {
        await this.invoker.delete(ref);
    }

    /** No options = a generated name, no deadline, no customizer, webpieces-owned timing. */
    private infoFor(epochMsToRunAt: number | undefined, opts: ScheduleOptions | undefined): ScheduleInfo {
        const options = opts ?? new ScheduleOptions();
        return new ScheduleInfo(
            options.taskName,
            epochMsToRunAt,
            options.taskTimeoutSeconds,
            options.customizeTask,
            options.gax,
        );
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
