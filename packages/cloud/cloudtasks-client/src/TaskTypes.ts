import { AuthMeta, AuthMode } from '@webpieces/core-util';
import type { protos } from '@google-cloud/tasks';
import type { CallOptions } from 'google-gax';
import { TaskName } from './TaskName';

/** The Google `CreateTask` request: `{ parent, task }`, built by webpieces on every attempt. */
export type ICreateTaskRequest = protos.google.cloud.tasks.v2.ICreateTaskRequest;

/**
 * Changes the Google request of ONE enqueue attempt. It runs on every attempt, LAST, on a freshly
 * built `ICreateTaskRequest` (url, body, headers, auth, name, scheduleTime and dispatchDeadline are
 * already set) and returns the request to send — the same object mutated, or a new one.
 *
 * It is Google-request-only and never touches timing: gax `CallOptions` are
 * `ScheduleOptions.gax` / `GcpTaskRegistry.setGax`. If it changes `task.name`, it must stay under the
 * same queue path and return the same name on every attempt, or webpieces' own retries can create
 * duplicates. The in-memory invoker has no Google request and ignores it.
 */
export type TaskCustomizer = (request: ICreateTaskRequest) => ICreateTaskRequest;

/**
 * Scheduling options for an enqueued task. Travels out-of-band (via the scheduler
 * frame in RequestContext) so the shared API method signature stays `foo(req)` on
 * both the client and the controller.
 */
export class ScheduleInfo {
    constructor(
        /** How the task is named; resolved ONCE per logical enqueue by `TaskProxyClient`. */
        readonly taskName: TaskName,
        /** Absolute epoch-millis to run at; omitted = run as soon as possible. */
        readonly epochMsToRunAt?: number,
        /** Per-task dispatch deadline in seconds (`task.dispatchDeadline`). */
        readonly taskTimeoutSeconds?: number,
        /** The call site's {@link TaskCustomizer}; wins over `GcpTaskRegistry.setCustomizer`. */
        readonly customizeTask?: TaskCustomizer,
        /** The call site's gax `CallOptions`; set ⇒ the caller owns timing for this enqueue. */
        readonly gax?: CallOptions,
    ) {}
}

/** Handle to an enqueued task (its Cloud Tasks name), returned by the scheduler. */
export class JobReference {
    constructor(
        /** The task's full resource name (`projects/.../tasks/<id>`), or the in-memory task id. */
        readonly taskId: string,
        /**
         * True when the task already existed (ALREADY_EXISTS): a retry whose earlier attempt landed,
         * or a `TaskName.dedup` collision. Reported as success, never as an error.
         */
        readonly alreadyExisted: boolean,
    ) {}
}

/**
 * What `TaskProxyClient` resolved ONCE for a logical enqueue, before any attempt: the task id every
 * attempt carries, and the EFFECTIVE customizer and gax options (call site, else `GcpTaskRegistry`
 * method -> API -> ALL).
 */
export class EnqueuePlan {
    constructor(
        /** The task id (not the full path); undefined = let Cloud Tasks assign one. */
        readonly taskId: string | undefined,
        readonly customizeTask?: TaskCustomizer,
        /** Set ⇒ the caller owns timing: one attempt, `createTask(request, gax)` as given. */
        readonly gax?: CallOptions,
    ) {}
}

/**
 * Everything an invoker needs to enqueue one task. Built by the enqueue proxy from
 * the shared @PubSub contract's decorators + the ambient RequestContext.
 */
export class TaskRequest {
    constructor(
        /** Callee base URL (e.g. https://email-svc-123.us-central1.run.app). */
        readonly targetUrl: string,
        /** Endpoint path the task is delivered to (basePath + endpoint, e.g. /email/send). */
        readonly path: string,
        /** Cloud Tasks queue name (getQueueName: @Queue override or `${Api}-${method}`). */
        readonly queueName: string,
        /** The request DTO (serialized to the POST body on delivery). */
        // webpieces-disable no-any-unknown -- request DTO type is erased at the task boundary
        readonly body: unknown,
        /** Context headers to propagate (txId/requestId/tenant…), already resolved. */
        readonly contextHeaders: Map<string, string>,
        /** The endpoint's auth mode — how the invoker authenticates delivery. */
        readonly authMode: AuthMode,
        /** Scheduling options (run-at, dispatch deadline). */
        readonly scheduleInfo: ScheduleInfo,
        /** The resolved name, customizer and gax for this logical enqueue. */
        readonly plan: EnqueuePlan,
    ) {}
}

/**
 * The transport that actually enqueues a task. Abstract class so it doubles as the
 * inversify DI token (inject by type, no Symbol). Bind GcpTaskInvoker in prod or
 * InMemoryTaskInvoker in tests/local dev. Both deliver a task the same way — a plain
 * HTTP POST to `targetUrl + path` — GcpTaskInvoker via Google Cloud Tasks, and
 * InMemoryTaskInvoker via an in-process queue that fetches the target directly.
 *
 * An invoker performs ONE attempt and never retries: retries belong to `CallRegistry` (webpieces'
 * `RetryStrategy` by default) or, when `plan.gax` is set, to gax. It throws
 * `TaskAlreadyExistsError` for a name that already exists.
 */
export abstract class TaskInvoker {
    selectAuthentication(meta: AuthMeta): AuthMode {
        const selected = meta.methods.find((method: AuthMode) => method.kind === 'oidc' || method.kind === 'public');
        if (selected) return selected;
        if (meta.methods.length === 1) return meta.methods[0];
        throw new Error('No configured Cloud Tasks credential satisfies the declared alternatives.');
    }

    /**
     * Enqueue ONE attempt.
     *
     * @param request - the task, including the resolved {@link EnqueuePlan}
     * @param timeoutMs - this attempt's deadline (webpieces' attempt timeout, or the safety cap when
     *   the caller owns timing); the GCP invoker sends it as the gRPC deadline
     * @param signal - aborted when the attempt's deadline fires
     */
    abstract enqueue(request: TaskRequest, timeoutMs: number, signal: AbortSignal): Promise<JobReference>;
    abstract delete(ref: JobReference): Promise<void>;
}
