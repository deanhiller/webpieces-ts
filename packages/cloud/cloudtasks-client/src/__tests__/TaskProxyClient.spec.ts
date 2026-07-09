import 'reflect-metadata';

// Force gcp-metadata to report "not on GCP" instantly so these tests are hermetic
// (no metadata-server probe / network). Must be set before the module is imported.
process.env['METADATA_SERVER_DETECTION'] = 'none';
// The callee's base URL is resolved from the service name via getCloudRunUrl, which
// honours this override — this is exactly how a local multi-service run points at a port.
process.env['CLOUD_RUN_URL_EMAIL_SVC'] = 'http://localhost:18299';

import { describe, it, expect, beforeEach } from 'vitest';
import {
    ApiPath,
    AuthOidc,
    ContextKey,
    Endpoint,
    HeaderRegistry,
    PubSub,
    Queue,
    WebpiecesCoreHeaders,
} from '@webpieces/core-util';
import { RequestContext } from '@webpieces/core-context';
import { ClientCloudTasksFactory } from '../ClientCloudTasksFactory';
import { CloudTaskScheduler } from '../CloudTaskScheduler';
import { TaskClientConfig } from '../TaskClientConfig';
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
const AUTH = new ContextKey('authorization', 'authorization', /*isSecured*/ true);
const SHARED_SECRET = new ContextKey('sharedSecret', 'x-webpieces-shared-secret', /*isSecured*/ true);

describe('TaskProxyClient enqueue', () => {
    let invoker: CapturingTaskInvoker;
    let emailTasks: EmailApi;
    let scheduler: CloudTaskScheduler;

    beforeEach(() => {
        HeaderRegistry.configure([TENANT, AUTH, SHARED_SECRET], [], /*platformHeaders*/ true);
        invoker = new CapturingTaskInvoker();
        // Client construction is SYNCHRONOUS — no await, even though the URL resolve is async.
        emailTasks = new ClientCloudTasksFactory(invoker)
            .createClient(EmailApi, new TaskClientConfig('email-svc'));
        scheduler = new CloudTaskScheduler(invoker);
    });

    it('resolves the target URL from the service name and builds the task request', async () => {
        await RequestContext.run(async () => {
            const ref = await scheduler.addToQueue(
                () => emailTasks.sendEmail(new SendEmailRequest('a@b.com')),
                { dedupName: 'dedup-42' },
            );
            expect(ref.taskId).toBe('captured-task-1');
        });

        const request = invoker.captured!;
        expect(request.targetUrl).toBe('http://localhost:18299'); // from CLOUD_RUN_URL_EMAIL_SVC
        expect(request.path).toBe('/email/send');
        expect(request.queueName).toBe('email-send-queue'); // @Queue override, not EmailApi-sendEmail
        expect(request.authMode.kind).toBe('oidc');
        expect(request.scheduleInfo.dedupName).toBe('dedup-42');
        expect((request.body as SendEmailRequest).to).toBe('a@b.com');
    });

    it('propagates context headers but STRIPS the caller\'s auth credentials', async () => {
        await RequestContext.run(async () => {
            RequestContext.putHeader(TENANT, 'tenant-42');
            RequestContext.putHeader(AUTH, 'Bearer caller-user-jwt');
            RequestContext.putHeader(SHARED_SECRET, 'caller-secret-value');
            RequestContext.putHeader(WebpiecesCoreHeaders.REQUEST_ID, 'req-abc');

            await scheduler.addToQueue(() => emailTasks.sendEmail(new SendEmailRequest('a@b.com')));
        });

        const headers = invoker.captured!.contextHeaders;
        // Transferred context rides along...
        expect(headers.get('x-tenant-id')).toBe('tenant-42');
        expect(headers.get('x-previous-request-id')).toBe('req-abc'); // request-id chaining applied
        // ...but the caller's credentials must NEVER leak onto an enqueued task; the invoker
        // mints fresh delivery auth per the endpoint's @AuthOidc mode.
        expect(headers.has('authorization')).toBe(false);
        expect(headers.has('x-webpieces-shared-secret')).toBe(false);
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
