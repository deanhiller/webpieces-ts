/** Constructor whose prototype is T (the abstract @PubSub API class). */
export type ApiPrototype<T> = Function & { prototype: T };

/**
 * Per-client STATE for a Cloud Tasks enqueue client — nothing else.
 *
 * Only the callee's Cloud Run service name. The base URL is derived from it at enqueue
 * time by `getCloudRunUrl`, which honours a `CLOUD_RUN_URL_<UPPER_SNAKE_NAME>` env
 * override (local multi-service runs, integration tests) and falls back off-GCP to
 * `http://<svc>.localhost.invalid`. So there is no separate "fixed URL" client shape.
 *
 * Collaborators (TaskInvoker, ContextMgr) are NOT config: they are dependencies of
 * {@link ClientCloudTasksFactory} and shared by every client it builds.
 */
export class TaskClientConfig {
    /** The callee's Cloud Run service name (e.g. 'email-svc'). */
    gcpCloudRunSvcName: string;

    constructor(gcpCloudRunSvcName: string) {
        this.gcpCloudRunSvcName = gcpCloudRunSvcName;
    }
}
