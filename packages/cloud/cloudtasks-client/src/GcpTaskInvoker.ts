import { injectable, inject, optional } from 'inversify';
import { CloudTasksClient, protos } from '@google-cloud/tasks';
import { provideFrameworkSingleton } from '@webpieces/core-context';
import {
    getProjectId,
    getRegion,
    getRuntimeServiceAccountEmail,
} from '@webpieces/gcp-identity';
import { LogManager, Secrets } from '@webpieces/core-util';
import { TaskInvoker, TaskRequest, JobReference } from './TaskTypes';

const log = LogManager.getLogger('GcpTaskInvoker');

type ITask = protos.google.cloud.tasks.v2.ITask;

/**
 * TaskInvoker that enqueues to Google Cloud Tasks (`@google-cloud/tasks`). Builds an
 * HTTP-target task delivered as POST to `targetUrl + path`, authenticated per the
 * endpoint's auth mode (OIDC token minted as this service's runtime SA, or a
 * shared-secret header). The task name is derived from the dedup name for idempotency
 * (a duplicate enqueue is rejected ALREADY_EXISTS = idempotent success upstream).
 */
@provideFrameworkSingleton()
@injectable()
export class GcpTaskInvoker extends TaskInvoker {
    private readonly client = new CloudTasksClient();

    // @optional: only @AuthSharedSecret task endpoints need it; the client sends its bound value.
    constructor(@optional() @inject(Secrets) private readonly secrets?: Secrets) {
        super();
    }

    override async enqueue(request: TaskRequest): Promise<JobReference> {
        const projectId = await getProjectId();
        const region = await getRegion();
        const parent = this.client.queuePath(projectId, region, request.queueName);

        const task = await this.buildTask(request, parent);
        const result = await this.client.createTask({ parent: parent, task: task });
        const created = result[0];
        const name = created.name ?? request.scheduleInfo.dedupName ?? 'unknown';
        log.info(`enqueued cloud task ${name}`);
        return new JobReference(name);
    }

    override async delete(ref: JobReference): Promise<void> {
        await this.client.deleteTask({ name: ref.taskId });
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
        if (request.scheduleInfo.dedupName) {
            task.name = `${parent}/tasks/${request.scheduleInfo.dedupName}`;
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
