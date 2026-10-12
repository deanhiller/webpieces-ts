import { AuthMeta, AuthMode, CallDeadline, toError } from '@webpieces/core-util';
import { inject, optional } from 'inversify';
import { CloudTasksClient, protos } from '@google-cloud/tasks';
import type { CallOptions } from 'google-gax';
import { provideFrameworkSingletonDefaultForApi } from '@webpieces/core-context';
import { getProjectId, getRegion, getRuntimeServiceAccountEmail } from '@webpieces/gcp-identity';
import { LogManager, Secrets, SECRETS } from '@webpieces/core-util';
import { TaskInvoker, TaskRequest, JobReference, ICreateTaskRequest } from './TaskTypes';
import { CloudTasksClientProvider } from './CloudTasksClientProvider';
import { GrpcErrorMapper } from './GrpcErrorMapper';

const log = LogManager.getLogger('GcpTaskInvoker');

type ITask = protos.google.cloud.tasks.v2.ITask;

/**
 * TaskInvoker that enqueues to Google Cloud Tasks (`@google-cloud/tasks`). Builds an
 * HTTP-target task delivered as POST to `targetUrl + path`, authenticated per the
 * endpoint's auth mode (OIDC token minted as this service's runtime SA, or a
 * shared-secret header).
 *
 * ONE attempt per call, never a retry of its own:
 * - it builds a FRESH `ICreateTaskRequest` (gax mutates what it is handed), names the task with the
 *   id `TaskProxyClient` resolved once for the whole logical enqueue, then applies the effective
 *   {@link TaskCustomizer} last;
 * - it sends `createTask(request, { timeout: timeoutMs })` — a real gRPC deadline per attempt, and no
 *   gax retry — unless the caller owns timing (`plan.gax` set), in which case it sends a shallow copy
 *   of the caller's `CallOptions`, untouched;
 * - it maps the gRPC failure with {@link GrpcErrorMapper}: ALREADY_EXISTS becomes
 *   `TaskAlreadyExistsError` (success, upstream), UNAVAILABLE / DEADLINE_EXCEEDED /
 *   RESOURCE_EXHAUSTED become transient webpieces errors that `RetryStrategy` retries.
 *
 * Cancellation: the gRPC deadline IS the attempt deadline, so on Path A gRPC itself cancels the RPC
 * at the same moment `CallDeadline` gives up on it. `createTask`'s public promise carries no
 * `cancel()` (the client chains `.then` on gax's cancellable promise, which drops it), so the abort
 * signal is checked before sending rather than wired to a cancel.
 */
// Default (overridable) impl of the TaskInvoker contract: binds `TaskInvoker -> GcpTaskInvoker`
// as a framework singleton. Tests/local dev override it via appOverrides:
// `(await options.rebind(TaskInvoker)).to(InMemoryTaskInvoker)` — same idiom as AuthConfig.
@provideFrameworkSingletonDefaultForApi(TaskInvoker)
export class GcpTaskInvoker extends TaskInvoker {
    private readonly client: CloudTasksClient;
    private readonly grpcErrorMapper = new GrpcErrorMapper();

    constructor(
        // webpieces-disable inject-annotation-not-needed-for-concrete-class -- DI-resolved param; the esbuild/vitest path elides type-only imports (no design:paramtypes), so the explicit token is required
        @inject(CloudTasksClientProvider) clientProvider: CloudTasksClientProvider,
        // @optional: only sharedSecret(...) task endpoints need it; the client sends its bound value.
        @optional() @inject(SECRETS) private readonly secrets?: Secrets,
    ) {
        super();
        this.client = clientProvider.create();
    }

    override selectAuthentication(meta: AuthMeta): AuthMode {
        const selected = meta.methods.find((method: AuthMode) => method.kind === 'oidc' || method.kind === 'public' ||
            (method.kind === 'shared-secret' && this.secrets?.get(method.secretKey) !== undefined));
        if (!selected) throw new Error('No declared task credential has a configured delivery mechanism.');
        return selected;
    }

    override async enqueue(
        request: TaskRequest,
        timeoutMs: number,
        signal: AbortSignal,
    ): Promise<JobReference> {
        const projectId = await getProjectId();
        const region = await getRegion();
        const parent = this.client.queuePath(projectId, region, request.queueName);

        const built: ICreateTaskRequest = { parent: parent, task: await this.buildTask(request, parent) };
        const customize = request.plan.customizeTask;
        const createRequest = customize ? customize(built) : built;
        const taskName = createRequest.task?.name ?? undefined;
        CallDeadline.throwIfAborted(signal);

        let created: protos.google.cloud.tasks.v2.ITask;
        // webpieces-disable no-unmanaged-exceptions -- translate the gRPC failure into the webpieces taxonomy
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            const result = await this.client.createTask(createRequest, this.callOptions(request, timeoutMs));
            created = result[0];
        } catch (err: unknown) {
            const error = toError(err);
            throw this.grpcErrorMapper.map(error, taskName);
        }
        const name = created.name ?? taskName ?? 'unknown';
        log.info(`enqueued cloud task ${name}`);
        return new JobReference(name, false);
    }

    override async delete(ref: JobReference): Promise<void> {
        await this.client.deleteTask({ name: ref.taskId });
    }

    /**
     * A NEW object on every attempt. webpieces owns timing → `{ timeout }` only: a real gRPC deadline
     * and no gax retry loop. The caller owns timing → a shallow copy of their options, so gax's own
     * mutation (`otherArgs.headers`) never lands on an object the caller may reuse.
     */
    private callOptions(request: TaskRequest, timeoutMs: number): CallOptions {
        const gax = request.plan.gax;
        return gax === undefined ? { timeout: timeoutMs } : { ...gax };
    }

    private async buildTask(request: TaskRequest, parent: string): Promise<ITask> {
        const headers = new Map<string, string>(request.contextHeaders);
        headers.set('content-type', 'application/json');

        const httpRequest: protos.google.cloud.tasks.v2.IHttpRequest = {
            httpMethod: 'POST',
            url: request.targetUrl + request.path,
            headers: Object.fromEntries(headers),
            body: Buffer.from(JSON.stringify(request.body ?? {}), 'utf8').toString('base64'),
        };
        await this.applyAuth(request, httpRequest, headers);

        const task: ITask = { httpRequest: httpRequest };
        if (request.plan.taskId !== undefined) {
            task.name = `${parent}/tasks/${request.plan.taskId}`;
        }
        if (request.scheduleInfo.epochMsToRunAt) {
            task.scheduleTime = { seconds: Math.floor(request.scheduleInfo.epochMsToRunAt / 1000) };
        }
        if (request.scheduleInfo.taskTimeoutSeconds) {
            task.dispatchDeadline = { seconds: request.scheduleInfo.taskTimeoutSeconds };
        }
        return task;
    }

    private async applyAuth(
        request: TaskRequest,
        httpRequest: protos.google.cloud.tasks.v2.IHttpRequest,
        headers: Map<string, string>,
    ): Promise<void> {
        const mode = request.authMode;
        if (mode.kind === 'oidc') {
            httpRequest.oidcToken = {
                serviceAccountEmail: await getRuntimeServiceAccountEmail(),
                audience: request.targetUrl,
            };
            return;
        }
        if (mode.kind === 'shared-secret') {
            const secret = this.secrets?.get(mode.secretKey);
            if (secret) {
                // One credential header; the 'Webpieces' scheme says a shared secret follows, not a token.
                headers.set('authorization', `Webpieces ${secret}`);
                httpRequest.headers = Object.fromEntries(headers);
            }
        }
    }
}
