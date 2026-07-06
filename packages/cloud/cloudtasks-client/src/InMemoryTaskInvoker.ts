import { inject, injectable } from 'inversify';
import { provideSingleton } from '@webpieces/core-context';
import { mintIdToken } from '@webpieces/gcp-identity';
import { LogManager } from '@webpieces/core-util';
import { TaskInvoker, TaskRequest, JobReference, LocalTaskDispatcher } from './TaskTypes';

const log = LogManager.getLogger('InMemoryTaskInvoker');

/**
 * TaskInvoker for tests + local dev: instead of enqueuing to Google Cloud Tasks, it
 * dispatches the call straight into the local server's per-route filter chain +
 * controller — synthesizing exactly the auth + context headers Cloud Tasks would
 * deliver. This is what gives cloud-task flows PRODUCTION PARITY in tests with no GCP
 * and no socket: ContextFilter, ServiceAuthFilter and the controller all run for real.
 *
 * Bind it (via appOverrides) in place of GcpTaskInvoker:
 *   bind(TaskInvoker).to(InMemoryTaskInvoker)
 */
@provideSingleton()
@injectable()
export class InMemoryTaskInvoker extends TaskInvoker {
    private counter = 0;

    constructor(
        @inject(LocalTaskDispatcher) private readonly dispatcher: LocalTaskDispatcher,
    ) {
        super();
    }

    override async enqueue(request: TaskRequest): Promise<JobReference> {
        const headers = new Map<string, string>(request.contextHeaders);
        await this.attachAuth(request, headers);

        log.debug(`in-memory dispatch ${request.queueName} -> ${request.path}`);
        // Runs the delivered task through the real filter chain + controller NOW.
        await this.dispatcher.dispatch(request.path, request.body, headers);

        this.counter += 1;
        const taskId = request.scheduleInfo.dedupName ?? `inmem-${request.queueName}-${this.counter}`;
        return new JobReference(taskId);
    }

    override async delete(_ref: JobReference): Promise<void> {
        // Nothing enqueued to a real backend — no-op.
    }

    /** Synthesize the delivery credential Cloud Tasks would attach, per the auth mode. */
    private async attachAuth(request: TaskRequest, headers: Map<string, string>): Promise<void> {
        const mode = request.authMode;
        if (mode.kind === 'oidc') {
            const token = await mintIdToken(request.targetUrl);
            headers.set('authorization', `Bearer ${token}`);
            return;
        }
        if (mode.kind === 'shared-secret') {
            const secret = process.env[mode.secretEnv];
            if (secret) {
                headers.set('x-webpieces-shared-secret', secret);
            }
            return;
        }
        // public / jwt → no service credential is synthesized.
    }
}
