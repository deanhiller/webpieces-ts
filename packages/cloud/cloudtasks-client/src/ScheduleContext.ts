import { RequestContext } from '@webpieces/core-context';
import { ScheduleInfo, JobReference } from './TaskTypes';

/**
 * The scheduler→proxy bridge for the current async scope. The CloudTaskScheduler
 * sets a frame around a runnable; the enqueue proxy reads its ScheduleInfo and, after
 * enqueuing, writes back the JobReference. Stored in the request's AsyncLocalStorage
 * frame so it never leaks across requests.
 */
export class ScheduleFrame {
    info: ScheduleInfo;
    jobRef?: JobReference;

    constructor(info: ScheduleInfo) {
        this.info = info;
    }
}

/** Non-transferrable context key for the active schedule frame. */
const SCHEDULE_FRAME_KEY = '__webpieces_schedule_frame';

/** Install a schedule frame for the current scope (called by the scheduler). */
export function setScheduleFrame(frame: ScheduleFrame): void {
    RequestContext.put(SCHEDULE_FRAME_KEY, frame);
}

/** The active schedule frame, or undefined if no scheduler lambda is running. */
export function currentScheduleFrame(): ScheduleFrame | undefined {
    return RequestContext.get<ScheduleFrame>(SCHEDULE_FRAME_KEY);
}

/** Remove the schedule frame (called by the scheduler in a finally). */
export function clearScheduleFrame(): void {
    RequestContext.remove(SCHEDULE_FRAME_KEY);
}
