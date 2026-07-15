import 'reflect-metadata';

// Force gcp-metadata to report "not on GCP" instantly so these tests are hermetic
// (no metadata-server probe / network). Must be set before the module is imported.
process.env['METADATA_SERVER_DETECTION'] = 'none';

import { describe, it, expect, beforeEach } from 'vitest';
import {
    ApiPath,
    ApiCallContextHolder,
    AuthOidc,
    ContextKey,
    Endpoint,
    HeaderRegistry,
    ClientRegistry,
    PubSub,
    Queue,
    WebpiecesCoreHeaders,
} from '@webpieces/core-util';
import { RequestContext, RequestContextApiCallContext } from '@webpieces/core-context';
import { Provider, RequestContextHeaders } from '@webpieces/core-context';
import { ClientCloudTasksFactory } from '../ClientCloudTasksFactory';
import { CloudTaskScheduler } from '../CloudTaskScheduler';
import { TaskClientConfig } from '../TaskClientConfig';
import { TaskProxyClient } from '../TaskProxyClient';
import { TaskInvoker, TaskRequest, JobReference } from '../TaskTypes';

class SendEmailRequest {
    to: string;

    constructor(to: string) {
        this.to = to;
    }
}

/** A @PubSub contract shared by the enqueue client and (in prod) the controller. */
@PubSub()
@AuthOidc()
@ApiPath('/email')
abstract class EmailApi {
    @Endpoint('/send')
    @Queue('email-send-queue')
    // webpieces-disable no-unmanaged-exceptions -- abstract contract stub, never executed
    sendEmail(_request: SendEmailRequest): Promise<void> {
        throw new Error('contract only');
    }
}

/** Captures the TaskRequest instead of enqueuing it, so we can assert on what was built. */
class CapturingTaskInvoker extends TaskInvoker {
    captured?: TaskRequest;

    override async enqueue(request: TaskRequest): Promise<JobReference> {
        this.captured = request;
        return new JobReference('captured-task-1');
    }

    override async delete(_ref: JobReference): Promise<void> {
        // nothing queued to cancel
    }
}

const TENANT = new ContextKey('tenantId', 'x-tenant-id');

let invoker: CapturingTaskInvoker;
let emailTasks: EmailApi;
let scheduler: CloudTaskScheduler;

/**
 * In prod the container supplies the provider (bindFrameworkProvider); here we hand it the
 * resolve-lambda directly — the same seam, minus the container. Client construction is
 * SYNCHRONOUS even though the URL resolve is async.
 */
function clientFor(config: TaskClientConfig): EmailApi {
    const provider = new Provider(
        () => new TaskProxyClient(invoker, new RequestContextHeaders()),
    );
    return new ClientCloudTasksFactory(provider).createPubSubClient(EmailApi, config);
}

beforeEach(() => {
    HeaderRegistry.configure([TENANT], /*platformHeaders*/ true);
    // enqueue now routes through LogApiCall (like ProxyClient for http), which requires an installed
    // ApiCallContext — setupRuntime does this on a real server; a unit test installs it directly.
    ApiCallContextHolder.install(new RequestContextApiCallContext());
    // Off-GCP the callee's base URL is resolved from the service name via the local registry —
    // this is exactly how a local multi-service run points a svcName at a port.
    ClientRegistry.clear();
    ClientRegistry.addUrlMapping('email-svc', 'http://localhost:18299');
    invoker = new CapturingTaskInvoker();
    emailTasks = clientFor(new TaskClientConfig('email-svc'));
    scheduler = new CloudTaskScheduler(invoker);
});

describe('TaskProxyClient enqueue', () => {

    it('resolves the target URL from the service name and builds the task request', async () => {
        await RequestContext.run(async () => {
            const ref = await scheduler.addToQueue(
                () => emailTasks.sendEmail(new SendEmailRequest('a@b.com')),
                { dedupName: 'dedup-42' },
            );
            expect(ref.taskId).toBe('captured-task-1');
        });

        const request = invoker.captured!;
        expect(request.targetUrl).toBe('http://localhost:18299'); // from ClientRegistry('email-svc')
        expect(request.path).toBe('/email/send');
        expect(request.queueName).toBe('email-send-queue'); // @Queue override, not EmailApi-sendEmail
        expect(request.authMode.kind).toBe('oidc');
        expect(request.scheduleInfo.dedupName).toBe('dedup-42');
        expect((request.body as SendEmailRequest).to).toBe('a@b.com');
    });

    it("propagates context headers, and cannot leak the caller's credential", async () => {
        await RequestContext.run(async () => {
            RequestContext.putHeader(TENANT, 'tenant-42');
            RequestContext.putHeader(WebpiecesCoreHeaders.REQUEST_ID, 'req-abc');

            await scheduler.addToQueue(() => emailTasks.sendEmail(new SendEmailRequest('a@b.com')));
        });

        const headers = invoker.captured!.contextHeaders;
        // Transferred context rides along...
        expect(headers.get('x-tenant-id')).toBe('tenant-42');
        expect(headers.get('x-request-id')).toBe('req-abc'); // propagated unchanged onto the task

        // ...but `authorization` is NOT a ContextKey, so the inbound transfer never puts the caller's
        // credential into the RequestContext and nothing here can transfer it. The invoker mints
        // the task's own delivery auth per the endpoint's @AuthOidc / @AuthSharedSecret mode.
        expect(headers.has('authorization')).toBe(false);
    });

    it('throws when an endpoint is called outside a CloudTaskScheduler lambda', async () => {
        await RequestContext.run(async () => {
            await expect(emailTasks.sendEmail(new SendEmailRequest('a@b.com')))
                .rejects.toThrow(/must run inside a CloudTaskScheduler lambda/);
        });
    });

    it('throws on a method the contract does not declare', () => {
        // webpieces-disable no-any-unknown -- deliberately probing an undeclared method
        expect(() => (emailTasks as any).notAnEndpoint)
            .toThrow(/No @PubSub endpoint 'notAnEndpoint'/);
    });

});

describe('TaskProxyClient target resolution + request scope', () => {
    it('refuses to enqueue outside a RequestContext — a task with no trace is a bug', async () => {
        // Inside a scheduler frame, but NO RequestContext.run: the scheduler catches it first.
        await expect(scheduler.addToQueue(() => emailTasks.sendEmail(new SendEmailRequest('a@b.com'))))
            .rejects.toThrow(/RequestContext/);
        expect(invoker.captured).toBeUndefined();
    });

    it('a registered url mapping (cross-region / non-Cloud-Run) resolves the svcName', async () => {
        // No per-client targetUrl anymore: an environment reaches a non-derivable host by registering
        // the svcName's URL. Re-register 'email-svc' to a cross-region URL and it is used verbatim.
        ClientRegistry.addUrlMapping('email-svc', 'https://email.other-region.example');
        const pinned = clientFor(new TaskClientConfig('email-svc'));

        await RequestContext.run(async () => {
            await scheduler.addToQueue(() => pinned.sendEmail(new SendEmailRequest('a@b.com')));
        });

        expect(invoker.captured!.targetUrl).toBe('https://email.other-region.example');
    });
});
