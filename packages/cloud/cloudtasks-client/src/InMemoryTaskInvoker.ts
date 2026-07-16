import { inject, optional } from 'inversify';
import { provideFrameworkSingleton } from '@webpieces/core-context';
import { GcpOidc } from '@webpieces/gcp-identity';
import { LogManager, toError, Secrets, SECRETS } from '@webpieces/core-util';
import { TaskInvoker, TaskRequest, JobReference } from './TaskTypes';

const log = LogManager.getLogger('InMemoryTaskInvoker');

/**
 * TaskInvoker for tests + local dev — the in-memory-queue twin of GcpTaskInvoker
 * (a TypeScript port of webpieces-java's LocalRemoteInvoker).
 *
 * Instead of enqueuing to Google Cloud Tasks, it drops the delivery onto an in-process
 * timer queue and returns IMMEDIATELY (breaking from the caller, exactly like handing a
 * task to Cloud Tasks). The queued job then delivers the task the SAME way real Cloud
 * Tasks does: a plain HTTP POST to `targetUrl + path` with the JSON body and the
 * synthesized delivery auth (OIDC bearer / shared-secret). It does NOT invoke the server
 * in-process — the target may be a different process entirely — so the request travels
 * over real HTTP (e.g. http://localhost:{port}/queue/path) and is served by the target's
 * real routing + filter chain, giving production parity without GCP.
 *
 * Bind it (via appOverrides) in place of GcpTaskInvoker:
 *   bind(TaskInvoker).to(InMemoryTaskInvoker)
 */
@provideFrameworkSingleton()
export class InMemoryTaskInvoker extends TaskInvoker {
    private counter = 0;
    /** Scheduled (not-yet-delivered) jobs, so delete() can cancel them. */
    private readonly pending = new Map<string, ReturnType<typeof setTimeout>>();

    constructor(
        // webpieces-disable inject-annotation-not-needed-for-concrete-class -- DI-resolved param; the esbuild/vitest path elides type-only imports (no design:paramtypes), so the explicit token is required
        @inject(GcpOidc) private readonly gcpOidc: GcpOidc,
        // @optional: only @AuthSharedSecret task endpoints need it; the client sends its bound value.
        // webpieces-disable inject-annotation-not-needed-for-concrete-class -- DI-resolved param; the esbuild/vitest path elides type-only imports (no design:paramtypes), so the explicit token is required
        @optional() @inject(SECRETS) private readonly secrets?: Secrets,
    ) {
        super();
    }

    override async enqueue(request: TaskRequest): Promise<JobReference> {
        this.counter += 1;
        const taskId = request.scheduleInfo.dedupName ?? `inmem-${request.queueName}-${this.counter}`;
        const delayMs = this.computeDelayMs(request.scheduleInfo.epochMsToRunAt);

        // Break from the caller: queue the HTTP delivery and return the reference NOW.
        const timer = setTimeout(() => {
            this.pending.delete(taskId);
            void this.deliver(request, taskId);
        }, delayMs);
        // A queued task must not keep the process alive on its own.
        timer.unref?.();
        this.pending.set(taskId, timer);

        log.debug(`queued local task ${taskId} -> ${request.targetUrl}${request.path} (delay ${delayMs}ms)`);
        return new JobReference(taskId);
    }

    override async delete(ref: JobReference): Promise<void> {
        const timer = this.pending.get(ref.taskId);
        if (timer) {
            clearTimeout(timer);
            this.pending.delete(ref.taskId);
        }
    }

    /** ms until the scheduled run time (0 = as soon as possible / already due). */
    private computeDelayMs(epochMsToRunAt?: number): number {
        if (epochMsToRunAt === undefined) {
            return 0;
        }
        const delay = epochMsToRunAt - Date.now();
        return delay > 0 ? delay : 0;
    }

    /** Deliver the queued task over real HTTP, mirroring Cloud Tasks' HTTP callback. */
    private async deliver(request: TaskRequest, taskId: string): Promise<void> {
        const url = `${request.targetUrl}${request.path}`;
        const headers = await this.buildHeaders(request);
        log.info(`delivering local task ${taskId}: POST ${url}`);
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- detached queue job: log delivery failure, never crash the queue
        try {
            // webpieces-disable no-fetch -- in-memory queue delivers over real HTTP like Cloud Tasks (no server to invoke in-process)
            const response = await fetch(url, {
                method: 'POST',
                headers: headers,
                body: JSON.stringify(request.body ?? {}),
            });
            if (!response.ok) {
                log.error(`local task ${taskId} delivery to ${url} failed: HTTP ${response.status}`);
                return;
            }
            log.debug(`local task ${taskId} delivered: HTTP ${response.status}`);
        } catch (err: unknown) {
            const error = toError(err);
            log.error(`local task ${taskId} delivery to ${url} threw: ${error.message}`);
        }
    }

    /** content-type + propagated context headers + synthesized delivery credential. */
    private async buildHeaders(request: TaskRequest): Promise<Record<string, string>> {
        const headers: Record<string, string> = { 'content-type': 'application/json' };
        for (const entry of request.contextHeaders.entries()) {
            headers[entry[0]] = entry[1];
        }
        await this.attachAuth(request, headers);
        return headers;
    }

    /** Synthesize the delivery credential Cloud Tasks would attach, per the auth mode. */
    private async attachAuth(request: TaskRequest, headers: Record<string, string>): Promise<void> {
        const mode = request.authMode;
        if (mode.kind === 'oidc') {
            headers['authorization'] = `Bearer ${await this.gcpOidc.mintIdToken(request.targetUrl)}`;
            return;
        }
        if (mode.kind === 'shared-secret') {
            const secret = this.secrets?.get(mode.secretKey);
            if (secret) {
                // One credential header; the 'Webpieces' scheme says a shared secret follows, not a token.
                headers['authorization'] = `Webpieces ${secret}`;
            }
        }
        // public / jwt → no service credential is synthesized.
    }
}
