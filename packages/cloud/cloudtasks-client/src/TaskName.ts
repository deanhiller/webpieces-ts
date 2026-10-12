import { randomUUID } from 'crypto';

/** How a {@link TaskName} picks the Cloud Task id. */
enum TaskNameMode {
    DEDUP = 'dedup',
    GENERATED = 'generated',
    SERVER_ASSIGNED = 'server-assigned',
}

/**
 * How an enqueue names its Cloud Task — the id after `.../queues/<queue>/tasks/`.
 *
 * The name is resolved ONCE per logical enqueue (in `TaskProxyClient.enqueue`, before any attempt),
 * so every retry of that enqueue carries the SAME name. That is what makes the enqueue retry safe: an
 * attempt whose response was lost but whose task landed makes the retry answer ALREADY_EXISTS, which
 * is reported as success (`JobReference.alreadyExisted`), not as a second task.
 *
 * - {@link TaskName.generated} — the DEFAULT. One fresh UUID per logical enqueue, reused on every retry.
 * - {@link TaskName.dedup} — the CALLER's key: true dedup across callers and processes (a Twilio
 *   MessageSid, `org + period`, ...). A used name stays blocked for about an hour after its task runs
 *   or is deleted.
 * - {@link TaskName.serverAssigned} — no name: the fastest `createTask` (Google documents that named
 *   tasks add enqueue latency), at the price that a retry after a lost response may create a duplicate.
 */
export class TaskName {
    /** Cloud Tasks task ids: letters, digits, hyphens and underscores, at most 500 characters. */
    private static readonly VALID_ID = /^[A-Za-z0-9_-]{1,500}$/;

    private constructor(
        private readonly mode: TaskNameMode,
        private readonly id?: string,
    ) {}

    /** The caller's own dedup key, used verbatim as the task id. */
    // webpieces-disable no-function-outside-class -- named constructor of this value type
    static dedup(name: string): TaskName {
        if (!TaskName.VALID_ID.test(name)) {
            throw new RangeError(
                `TaskName.dedup('${name}') is not a valid Cloud Tasks task id: use only letters, ` +
                    'digits, hyphens and underscores, at most 500 characters.',
            );
        }
        return new TaskName(TaskNameMode.DEDUP, name);
    }

    /** The default: a fresh UUID for this logical enqueue, shared by every retry of it. */
    // webpieces-disable no-function-outside-class -- named constructor of this value type
    static generated(): TaskName {
        return new TaskName(TaskNameMode.GENERATED);
    }

    /** No name: Cloud Tasks assigns one. Fastest; a retry after a lost response may duplicate. */
    // webpieces-disable no-function-outside-class -- named constructor of this value type
    static serverAssigned(): TaskName {
        return new TaskName(TaskNameMode.SERVER_ASSIGNED);
    }

    /**
     * The task id to send, or `undefined` for a server-assigned name. Call ONCE per logical
     * enqueue: a generated name is a new UUID on every call.
     */
    resolve(): string | undefined {
        switch (this.mode) {
            case TaskNameMode.DEDUP:
                return this.id;
            case TaskNameMode.GENERATED:
                return randomUUID();
            case TaskNameMode.SERVER_ASSIGNED:
                return undefined;
        }
    }
}
