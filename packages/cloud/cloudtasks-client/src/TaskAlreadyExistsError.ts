/**
 * A task with this name already exists (Cloud Tasks ALREADY_EXISTS, gRPC code 6), or was used within
 * the last hour or so. Thrown by any {@link TaskInvoker}: `GcpTaskInvoker` on gRPC 6,
 * `InMemoryTaskInvoker` on a reused name.
 *
 * It is not a failure. Every attempt of one logical enqueue carries the same task name, so this is
 * either a retry whose earlier attempt actually landed, or a deliberate {@link TaskName.dedup}
 * collision — in both cases the task the caller asked for exists. `TaskProxyClient.enqueue` catches
 * it ONCE, above the retry layer, logs `WARN [ENQUEUE-DEDUP]`, and returns
 * `new JobReference(taskName, true)`. It never reaches application code.
 */
export class TaskAlreadyExistsError extends Error {
    constructor(
        /** The full task resource name (`projects/.../tasks/<id>`), or the in-memory task id. */
        public readonly taskName: string,
        cause?: Error,
    ) {
        super(`task ${taskName} already exists`, { cause });
        this.name = 'TaskAlreadyExistsError';
    }
}
