import { WpAuthorization, AuthorizationType, WpAuth, oidcSameProject } from '@webpieces/core-util';
import 'reflect-metadata';

// Force gcp-metadata to report "not on GCP" instantly so these tests are hermetic
// (no metadata-server probe / network). Must be set before the module is imported.
process.env['METADATA_SERVER_DETECTION'] = 'none';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ApiPath, ContextKey, Endpoint, HeaderRegistry, ClientRegistry, PubSub, Queue, WebpiecesCoreHeaders, CLOUDTASKS, POST, WRITE } from '@webpieces/core-util';
import { RequestContext } from '@webpieces/core-context';
import { Provider, RequestContextHeaders } from '@webpieces/core-context';
import { ClientCloudTasksFactory } from '../ClientCloudTasksFactory';
import { CloudTaskScheduler, ScheduleOptions } from '../CloudTaskScheduler';
import { TaskName } from '../TaskName';
import { GcpTaskRegistry } from '../GcpTaskRegistry';
import { InMemoryTaskInvoker } from '../InMemoryTaskInvoker';
import { TaskClientConfig } from '../TaskClientConfig';
import { TaskProxyClient } from '../TaskProxyClient';
import { TaskInvoker, TaskRequest, JobReference, ICreateTaskRequest } from '../TaskTypes';
import { GcpOidc } from '@webpieces/gcp-identity';

class SendEmailRequest {
    to: string;

    constructor(to: string) {
        this.to = to;
    }
}

/** A @PubSub contract shared by the enqueue client and (in prod) the controller. */
@PubSub()
@ApiPath('/email')
abstract class EmailApi {
    @WpAuth([oidcSameProject()])
    @WpAuthorization({ authType: AuthorizationType.SERVICE_ONLY })
    @Endpoint(POST, '/send', WRITE, CLOUDTASKS)
    @Queue('email-send-queue')
    // webpieces-disable no-unmanaged-exceptions -- abstract contract stub, never executed
    sendEmail(_request: SendEmailRequest): Promise<void> {
        throw new Error('contract only');
    }
}

/** Captures the TaskRequest instead of enqueuing it, so we can assert on what was built. */
class CapturingTaskInvoker extends TaskInvoker {
    captured?: TaskRequest;

    override async enqueue(request: TaskRequest, _timeoutMs: number, _signal: AbortSignal): Promise<JobReference> {
        this.captured = request;
        return new JobReference('captured-task-1', false);
    }

    override async delete(_ref: JobReference): Promise<void> {
        // nothing queued to cancel
    }
}

const TENANT = ContextKey.untrusted<string>('tenantId', 'x-tenant-id');

let invoker: CapturingTaskInvoker;
let emailTasks: EmailApi;
let scheduler: CloudTaskScheduler;

/**
 * In prod the container supplies the provider (bindFrameworkProvider); here we hand it the
 * resolve-lambda directly — the same seam, minus the container. Client construction is
 * SYNCHRONOUS even though the URL resolve is async.
 */
function clientFor(config: TaskClientConfig): EmailApi {
    const provider = new Provider(() => new TaskProxyClient(invoker, new RequestContextHeaders()));
    return new ClientCloudTasksFactory(provider).createPubSubClient(EmailApi, config);
}

beforeEach(() => {
    HeaderRegistry.configure([TENANT], /*platformHeaders*/ true);
    // Off-GCP the callee's base URL is resolved from the service name via the local registry —
    // this is exactly how a local multi-service run points a svcName at a port.
    ClientRegistry.resetForTests();
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
                new ScheduleOptions(TaskName.dedup('dedup-42')),
            );
            expect(ref.taskId).toBe('captured-task-1');
        });

        const request = invoker.captured!;
        expect(request.targetUrl).toBe('http://localhost:18299'); // from ClientRegistry('email-svc')
        expect(request.path).toBe('/email/send');
        expect(request.queueName).toBe('email-send-queue'); // @Queue override, not EmailApi-sendEmail
        expect(request.authMode.kind).toBe('oidc');
        expect(request.plan.taskId).toBe('dedup-42');
        expect((request.body as SendEmailRequest).to).toBe('a@b.com');
    });

    it("propagates context headers, and cannot leak the caller's credential", async () => {
        await RequestContext.run(async () => {
            RequestContext.putUntrusted(TENANT, 'tenant-42');
            RequestContext.putUntrusted(WebpiecesCoreHeaders.REQUEST_ID, 'req-abc');

            await scheduler.addToQueue(() => emailTasks.sendEmail(new SendEmailRequest('a@b.com')));
        });

        const headers = invoker.captured!.contextHeaders;
        // Transferred context rides along...
        expect(headers.get('x-tenant-id')).toBe('tenant-42');
        expect(headers.get('x-request-id')).toBe('req-abc'); // propagated unchanged onto the task

        // ...but `authorization` is NOT a ContextKey, so the inbound transfer never puts the caller's
        // credential into the RequestContext and nothing here can transfer it. The invoker mints
        // the task's own delivery auth per the endpoint's @WpAuthOidc / @WpAuthSharedSecret mode.
        expect(headers.has('authorization')).toBe(false);
    });

    it('throws when an endpoint is called outside a CloudTaskScheduler lambda', async () => {
        await RequestContext.run(async () => {
            await expect(emailTasks.sendEmail(new SendEmailRequest('a@b.com'))).rejects.toThrow(
                /must run inside a CloudTaskScheduler lambda/,
            );
        });
    });

    it('throws on a method the contract does not declare', () => {
        // webpieces-disable no-any-unknown -- deliberately probing an undeclared method
        expect(() => (emailTasks as any).notAnEndpoint).toThrow(
            /No @PubSub endpoint 'notAnEndpoint'/,
        );
    });
});

describe('TaskProxyClient target resolution + request scope', () => {
    it('refuses to enqueue outside a RequestContext — a task with no trace is a bug', async () => {
        // Inside a scheduler frame, but NO RequestContext.run: the scheduler catches it first.
        await expect(
            scheduler.addToQueue(() => emailTasks.sendEmail(new SendEmailRequest('a@b.com'))),
        ).rejects.toThrow(/RequestContext/);
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

/**
 * THE REGRESSION. A plain NestJS host (`services/orders-manager`) that had never run `setupRuntime`
 * used to get `ApiCallContext is not installed` on EVERY enqueue — a runtime throw on the first real
 * event, in a service that built and unit-tested green.
 *
 * Nothing in THIS FILE installs an ApiCallContext, and nothing calls setupRuntime: TaskProxyClient
 * builds its own RequestContextApiCallContext, because cloudtasks-client is node-only and already
 * depends on core-context. An open RequestContext is the ONLY thing an enqueue needs, and that is a
 * scope the host already opens per request.
 *
 * (The remaining process-globals a non-webpieces host must still configure are unchanged and
 * unrelated: HeaderRegistry, LogManager, ClientRegistry/deriver — see the beforeEach above.)
 */
describe('TaskProxyClient enqueues from a host that never ran setupRuntime', () => {
    it('does not throw "ApiCallContext is not installed" — no holder, no bootstrap', async () => {
        await RequestContext.run(async () => {
            const ref = await scheduler.addToQueue(() =>
                emailTasks.sendEmail(new SendEmailRequest('nest@host.example')),
            );
            expect(ref.taskId).toBe('captured-task-1');
        });

        expect((invoker.captured!.body as SendEmailRequest).to).toBe('nest@host.example');
    });
});

describe('TaskProxyClient task naming and per-enqueue resolution (#1199)', () => {
    const send = (opts?: ScheduleOptions): Promise<JobReference> =>
        RequestContext.run(() =>
            scheduler.addToQueue(() => emailTasks.sendEmail(new SendEmailRequest('a@b.com')), opts),
        );

    afterEach(() => GcpTaskRegistry.clear());

    it('names every enqueue by default with a generated UUID, and serverAssigned() sends no name', async () => {
        await send();
        expect(invoker.captured!.plan.taskId).toMatch(/^[0-9a-f-]{36}$/);
        const first = invoker.captured!.plan.taskId;
        await send();
        expect(invoker.captured!.plan.taskId).not.toBe(first);

        await send(new ScheduleOptions(TaskName.serverAssigned()));
        expect(invoker.captured!.plan.taskId).toBeUndefined();
    });

    it('rejects a dedup name Cloud Tasks would refuse, before anything is sent', () => {
        expect(() => TaskName.dedup('has/slash')).toThrow(RangeError);
        expect(() => TaskName.dedup('')).toThrow(RangeError);
        expect(TaskName.dedup('Order_42-a').resolve()).toBe('Order_42-a');
    });

    it('resolves customizer and gax: call site, else GcpTaskRegistry method -> API -> ALL', async () => {
        const global = (request: ICreateTaskRequest): ICreateTaskRequest => request;
        const perApi = (request: ICreateTaskRequest): ICreateTaskRequest => request;
        const callSite = (request: ICreateTaskRequest): ICreateTaskRequest => request;
        GcpTaskRegistry.setCustomizer(global, 'ALL');
        GcpTaskRegistry.setGax({ timeout: 1_000 }, 'ALL');
        await send();
        expect(invoker.captured!.plan.customizeTask).toBe(global);
        expect(invoker.captured!.plan.gax).toEqual({ timeout: 1_000 });

        GcpTaskRegistry.setCustomizer(perApi, EmailApi);
        GcpTaskRegistry.setGax({ timeout: 3_000 }, EmailApi, 'sendEmail');
        await send();
        expect(invoker.captured!.plan.customizeTask).toBe(perApi);
        expect(invoker.captured!.plan.gax).toEqual({ timeout: 3_000 });

        await send(new ScheduleOptions(TaskName.generated(), undefined, callSite, { timeout: 7 }));
        expect(invoker.captured!.plan.customizeTask).toBe(callSite);
        expect(invoker.captured!.plan.gax).toEqual({ timeout: 7 });
    });

    it('in-memory: a reused dedup name is ALREADY_EXISTS, reported as success with alreadyExisted', async () => {
        const inMemory = new InMemoryTaskInvoker(new GcpOidc());
        const provider = new Provider(() => new TaskProxyClient(inMemory, new RequestContextHeaders()));
        const client = new ClientCloudTasksFactory(provider).createPubSubClient(
            EmailApi,
            new TaskClientConfig('email-svc'),
        );
        const local = new CloudTaskScheduler(inMemory);
        const later = Date.now() + 3_600_000;
        const enqueue = (): Promise<JobReference> =>
            RequestContext.run(() =>
                local.schedule(
                    () => client.sendEmail(new SendEmailRequest('a@b.com')),
                    later,
                    new ScheduleOptions(TaskName.dedup('order-42')),
                ),
            );

        const first = await enqueue();
        const second = await enqueue();
        expect(first).toEqual(new JobReference('order-42', false));
        expect(second).toEqual(new JobReference('order-42', true));
        await local.cancelJob(first);
    });
});
