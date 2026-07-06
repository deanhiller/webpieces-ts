import { AuthMode } from '@webpieces/core-util';

/**
 * Scheduling options for an enqueued task. Travels out-of-band (via the scheduler
 * frame in RequestContext) so the shared API method signature stays `foo(req)` on
 * both the client and the controller.
 */
export class ScheduleInfo {
    /** Absolute epoch-millis to run at; omitted = run as soon as possible. */
    epochMsToRunAt?: number;
    /** Per-task dispatch deadline in seconds. */
    taskTimeoutSeconds?: number;
    /**
     * Deterministic dedup name → the Cloud Task resource name. A second enqueue with
     * the same name is rejected ALREADY_EXISTS (treated as success = idempotent).
     */
    dedupName?: string;

    constructor(epochMsToRunAt?: number, taskTimeoutSeconds?: number, dedupName?: string) {
        this.epochMsToRunAt = epochMsToRunAt;
        this.taskTimeoutSeconds = taskTimeoutSeconds;
        this.dedupName = dedupName;
    }
}

/** Handle to an enqueued task (its Cloud Tasks id), returned by the scheduler. */
export class JobReference {
    taskId: string;

    constructor(taskId: string) {
        this.taskId = taskId;
    }
}

/**
 * Everything an invoker needs to enqueue one task. Built by the enqueue proxy from
 * the shared @PubSub contract's decorators + the ambient RequestContext.
 */
export class TaskRequest {
    /** Callee base URL (e.g. https://email-svc-123.us-central1.run.app). */
    targetUrl: string;
    /** Endpoint path the task is delivered to (basePath + endpoint, e.g. /email/send). */
    path: string;
    /** Cloud Tasks queue name (getQueueName: @Queue override or `${Api}-${method}`). */
    queueName: string;
    /** The request DTO (serialized to the POST body on delivery). */
    // webpieces-disable no-any-unknown -- request DTO type is erased at the task boundary
    body: unknown;
    /** Context headers to propagate (txId/requestId/tenant…), already resolved. */
    contextHeaders: Map<string, string>;
    /** The endpoint's auth mode — how the invoker authenticates delivery. */
    authMode: AuthMode;
    /** Scheduling options (dedup name, run-at, timeout). */
    scheduleInfo: ScheduleInfo;

    constructor(
        targetUrl: string,
        path: string,
        queueName: string,
        // webpieces-disable no-any-unknown -- request DTO type is erased at the task boundary
        body: unknown,
        contextHeaders: Map<string, string>,
        authMode: AuthMode,
        scheduleInfo: ScheduleInfo,
    ) {
        this.targetUrl = targetUrl;
        this.path = path;
        this.queueName = queueName;
        this.body = body;
        this.contextHeaders = contextHeaders;
        this.authMode = authMode;
        this.scheduleInfo = scheduleInfo;
    }
}

/**
 * The transport that actually enqueues a task. Abstract class so it doubles as the
 * inversify DI token (inject by type, no Symbol). Bind GcpTaskInvoker in prod or
 * InMemoryTaskInvoker in tests/local dev.
 */
export abstract class TaskInvoker {
    abstract enqueue(request: TaskRequest): Promise<JobReference>;
    abstract delete(ref: JobReference): Promise<void>;
}

/**
 * Server-side seam that runs a delivered task through the real per-route filter
 * chain + controller in-process. Abstract class = DI token; the concrete impl lives
 * in @webpieces/http-server (it needs the RouteBuilder). Used by InMemoryTaskInvoker.
 */
export abstract class LocalTaskDispatcher {
    /**
     * Dispatch a task as if Cloud Tasks POSTed it: build the request headers (the
     * caller has already added auth) and run the endpoint's filter chain + controller.
     * @param path endpoint path (e.g. /email/send)
     * @param body the request DTO
     * @param headers inbound HTTP headers (lowercased name → single value)
     */
    // webpieces-disable no-any-unknown -- request DTO type is erased at the task boundary
    abstract dispatch(path: string, body: unknown, headers: Map<string, string>): Promise<void>;
}
