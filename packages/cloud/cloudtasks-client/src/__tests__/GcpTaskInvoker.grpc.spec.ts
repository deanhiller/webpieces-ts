import { WpAuthorization, AuthorizationType, WpAuth, oidcSameProject, CallScope } from '@webpieces/core-util';
import 'reflect-metadata';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CloudTasksClient } from '@google-cloud/tasks';
import { grpc } from 'google-gax';
import type { CallOptions } from 'google-gax';
import {
    ApiCallTimeoutError,
    ApiPath,
    ApiRetriesExhaustedError,
    ApiUnavailableError,
    ClientRegistry,
    Endpoint,
    HeaderRegistry,
    LogManager,
    Logger,
    LoggerFactory,
    PubSub,
    toError,
    CLOUDTASKS,
    POST,
    WRITE,
} from '@webpieces/core-util';
import { Provider, RequestContext, RequestContextHeaders } from '@webpieces/core-context';
import { ClientCloudTasksFactory } from '../ClientCloudTasksFactory';
import { CloudTaskScheduler, ScheduleOptions } from '../CloudTaskScheduler';
import { CloudTasksClientProvider } from '../CloudTasksClientProvider';
import { GcpTaskInvoker } from '../GcpTaskInvoker';
import { GcpTaskRegistry } from '../GcpTaskRegistry';
import { TaskClientConfig } from '../TaskClientConfig';
import { TaskName } from '../TaskName';
import { TaskProxyClient } from '../TaskProxyClient';
import { ICreateTaskRequest, JobReference } from '../TaskTypes';
import { FakeBehavior, FakeCloudTasksServer, ReceivedCreateTask } from './FakeCloudTasksServer';

/**
 * #1199 — the REAL GcpTaskInvoker and the REAL CloudTasksClient (real gax, real grpc-js, a real
 * socket) against a local fake Cloud Tasks server, wired through the full enqueue stack
 * (CloudTaskScheduler → generated client → TaskProxyClient → LogApiCall → ClientRegistry).
 *
 * Every scenario fails on the code before #1199: `createTask` was called with NO call options (gax's
 * own 20 s CreateTask deadline, no retry codes), every enqueue without a caller-chosen name was unnamed, and
 * ALREADY_EXISTS was thrown raw.
 */

class EmailRequest {
    constructor(public readonly to: string) {}
}

@PubSub()
@ApiPath('/email')
abstract class EmailApi {
    @WpAuth([oidcSameProject()])
    @WpAuthorization({ authType: AuthorizationType.SERVICE_ONLY })
    @Endpoint(POST, '/send', WRITE, CLOUDTASKS)
    // webpieces-disable no-unmanaged-exceptions -- abstract contract stub, never executed
    sendEmail(_request: EmailRequest): Promise<void> {
        throw new Error('contract only');
    }
}

/** The OPTIONAL client binding, overridden exactly as an app would: the fake endpoint, no TLS. */
class FakeEndpointClientProvider extends CloudTasksClientProvider {
    readonly clients: CloudTasksClient[] = [];

    constructor(private readonly port: number) {
        super();
    }

    override create(): CloudTasksClient {
        const client = new CloudTasksClient({
            apiEndpoint: '127.0.0.1',
            port: this.port,
            sslCreds: grpc.credentials.createInsecure(),
        });
        this.clients.push(client);
        return client;
    }
}

class CapturingLoggerFactory implements LoggerFactory {
    readonly lines: string[] = [];
    getLogger(_name: string): Logger {
        const record = (message: string): void => {
            this.lines.push(message);
        };
        return { trace: record, debug: record, info: record, warn: record, error: record };
    }
}

const QUEUE_PARENT = 'projects/local-project/locations/local/queues/EmailApi-sendEmail';
const UUID_TASK = new RegExp(`^${QUEUE_PARENT}/tasks/[0-9a-f-]{36}$`);
const server = new FakeCloudTasksServer();
const capturing = new CapturingLoggerFactory();
const originalFactory = LogManager.getFactory();
let provider: FakeEndpointClientProvider;
let invoker: GcpTaskInvoker;
let emailTasks: EmailApi;
let scheduler: CloudTaskScheduler;
let sentOptions: CallOptions[];

beforeAll(async () => {
    await server.start();
    HeaderRegistry.configure([], true);
    LogManager.setFactory(capturing);
    provider = new FakeEndpointClientProvider(server.port);
    invoker = new GcpTaskInvoker(provider, undefined);
    // Observe — never replace — what reaches the real client's createTask.
    const client = provider.clients[0];
    // Open the channel up front, so no scenario spends its first attempt on gax initialization.
    await client.initialize();
    const realCreateTask = client.createTask.bind(client);
    vi.spyOn(client, 'createTask').mockImplementation(
        // webpieces-disable no-any-unknown -- createTask's overloads are erased to its promise form here
        ((request: ICreateTaskRequest, options: CallOptions) => {
            sentOptions.push(options);
            return realCreateTask(request, options);
        }) as unknown as typeof client.createTask,
    );
    const factory = new ClientCloudTasksFactory(
        new Provider(() => new TaskProxyClient(invoker, new RequestContextHeaders())),
    );
    emailTasks = factory.createPubSubClient(EmailApi, new TaskClientConfig('email-svc'));
    scheduler = new CloudTaskScheduler(invoker);
});

afterAll(async () => {
    LogManager.setFactory(originalFactory);
    vi.restoreAllMocks();
    for (const client of provider.clients) {
        await client.close();
    }
    server.stop();
});

beforeEach(() => {
    server.received.length = 0;
    server.script = [];
    capturing.lines.length = 0;
    sentOptions = [];
    ClientRegistry.resetForTests();
    GcpTaskRegistry.clear();
    ClientRegistry.addUrlMapping('email-svc', 'https://email.example');
});

afterEach(() => {
    ClientRegistry.resetForTests();
    GcpTaskRegistry.clear();
});

function send(opts?: ScheduleOptions): Promise<JobReference> {
    return RequestContext.run(() =>
        scheduler.addToQueue(() => emailTasks.sendEmail(new EmailRequest('a@b.com')), opts),
    );
}

async function sendAndCatch(opts?: ScheduleOptions): Promise<Error | undefined> {
    return send(opts).then(
        () => undefined,
        (err: unknown) => {
            const error = toError(err);
            return error;
        },
    );
}

function linesWith(marker: string): string[] {
    return capturing.lines.filter((line: string) => line.includes(marker));
}

const deadlines = (): number[] => server.received.map((r: ReceivedCreateTask) => r.deadlineMs);

describe('GcpTaskInvoker over a real gRPC channel — Path A (webpieces owns timing)', () => {
    it('reset, then OK: attempt 2 carries a real 5 s deadline and the SAME generated name', async () => {
        server.script = [FakeBehavior.RESET, FakeBehavior.OK];

        const ref = await send();

        expect(server.received).toHaveLength(2);
        for (const deadline of deadlines()) {
            expect(deadline).toBeGreaterThan(4_000);
            expect(deadline).toBeLessThanOrEqual(5_000);
        }
        expect(server.received[0].taskName).toMatch(UUID_TASK);
        expect(server.received[1].taskName).toBe(server.received[0].taskName);
        expect(ref).toEqual(new JobReference(server.received[0].taskName!, false));
        expect(sentOptions).toHaveLength(2);
        expect(sentOptions[0]).toMatchObject({ timeout: 5_000 });
        expect(sentOptions[1]).toMatchObject({ timeout: 5_000 });
        expect(linesWith('[API-client-attempt-TRANSIENT]')).toHaveLength(1);
        expect(linesWith('[API-client-resp-SUCCESS]')).toHaveLength(1);
    }, 20_000);

    it('4 resets: ApiRetriesExhaustedError (cause ApiUnavailableError), 3 attempt WARN lines, 1 FAIL line', async () => {
        server.script = [FakeBehavior.RESET, FakeBehavior.RESET, FakeBehavior.RESET, FakeBehavior.RESET];

        const error = await sendAndCatch();

        expect(error).toBeInstanceOf(ApiRetriesExhaustedError);
        expect((error as ApiRetriesExhaustedError).attempts).toBe(4);
        expect(error?.cause).toBeInstanceOf(ApiUnavailableError);
        expect(server.received).toHaveLength(4);
        expect(new Set(server.received.map((r: ReceivedCreateTask) => r.taskName)).size).toBe(1);
        const attempts = linesWith('[API-client-attempt-TRANSIENT]');
        expect(attempts).toHaveLength(3);
        expect(attempts[0]).toContain('EmailApi.sendEmail attempt 1 errorType=ApiUnavailableError');
        const fails = linesWith('[API-client-resp-FAIL]');
        expect(fails).toHaveLength(1);
        expect(fails[0]).toContain('errorType=ApiRetriesExhaustedError');
    }, 20_000);

    it('silent server: the per-attempt deadline cancels the RPC, and the retry lands', async () => {
        server.script = [FakeBehavior.SILENT, FakeBehavior.OK];

        const ref = await send();

        expect(ref.alreadyExisted).toBe(false);
        expect(server.received).toHaveLength(2);
        expect(server.received[0].cancelled).toBe(true);
        expect(server.received[1].taskName).toBe(server.received[0].taskName);
    }, 20_000);

    it('reset, then ALREADY_EXISTS: success with alreadyExisted, logged [ENQUEUE-DEDUP]', async () => {
        server.script = [FakeBehavior.RESET, FakeBehavior.ALREADY_EXISTS];

        const ref = await send(new ScheduleOptions(TaskName.dedup('order-42')));

        expect(ref).toEqual(new JobReference(`${QUEUE_PARENT}/tasks/order-42`, true));
        expect(server.received.map((r: ReceivedCreateTask) => r.taskName)).toEqual([
            `${QUEUE_PARENT}/tasks/order-42`,
            `${QUEUE_PARENT}/tasks/order-42`,
        ]);
        const dedup = linesWith('[ENQUEUE-DEDUP]');
        expect(dedup).toHaveLength(1);
        expect(dedup[0]).toContain(`${QUEUE_PARENT}/tasks/order-42`);
        expect(linesWith('[API-client-resp-SUCCESS]')).toHaveLength(1);
        expect(linesWith('[API-client-resp-FAIL]')).toHaveLength(0);
    }, 20_000);

    it('serverAssigned(): no name on the wire', async () => {
        const ref = await send(new ScheduleOptions(TaskName.serverAssigned()));

        expect(server.received).toHaveLength(1);
        expect(server.received[0].taskName ?? '').toBe('');
        expect(ref.taskId).toBe(`${QUEUE_PARENT}/tasks/server-assigned-1`);
    }, 20_000);

    it('customizer: a mutated dispatchDeadline reaches the wire; a global one applies when the call site sets none', async () => {
        const deadline900 = (request: ICreateTaskRequest): ICreateTaskRequest => {
            request.task!.dispatchDeadline = { seconds: 900 };
            return request;
        };
        GcpTaskRegistry.setCustomizer((request: ICreateTaskRequest): ICreateTaskRequest => {
            request.task!.httpRequest!.headers!['x-priority'] = 'high';
            return request;
        }, CallScope.all());

        await send(new ScheduleOptions(TaskName.generated(), undefined, deadline900));
        await send();

        expect(server.received[0].dispatchDeadlineSeconds).toBe('900');
        expect(server.received[0].headers['x-priority']).toBeUndefined();
        expect(server.received[1].dispatchDeadlineSeconds).toBeUndefined();
        expect(server.received[1].headers['x-priority']).toBe('high');
    }, 20_000);
});

describe('GcpTaskInvoker over a real gRPC channel — Path B (gax set: the caller owns timing)', () => {
    it('call-site gax: exactly ONE attempt, no strategy, the caller CallOptions reach createTask', async () => {
        server.script = [FakeBehavior.RESET, FakeBehavior.OK];
        const gax: CallOptions = { timeout: 10_000 };

        const error = await sendAndCatch(
            new ScheduleOptions(TaskName.dedup('order-7'), undefined, undefined, gax),
        );

        expect(error).toBeInstanceOf(ApiUnavailableError);
        expect(server.received).toHaveLength(1);
        expect(server.received[0].deadlineMs).toBeGreaterThan(9_000);
        expect(sentOptions).toHaveLength(1);
        expect(sentOptions[0]).toMatchObject({ timeout: 10_000 });
        expect(gax).toEqual({ timeout: 10_000 });
        expect(linesWith('[API-client-attempt-TRANSIENT]')).toHaveLength(0);
        const fails = linesWith('[API-client-resp-FAIL]');
        expect(fails).toHaveLength(1);
        expect(fails[0]).toContain('errorType=ApiUnavailableError');
    }, 20_000);

    it('GcpTaskRegistry.setGax: the safety cap from the timeout ladder holds on a silent server', async () => {
        server.script = [FakeBehavior.SILENT];
        GcpTaskRegistry.setGax({ timeout: 10_000 }, CallScope.method(EmailApi, 'sendEmail'));
        ClientRegistry.setTimeout(300, CallScope.api(EmailApi));

        const started = Date.now();
        const error = await sendAndCatch();

        expect(error).toBeInstanceOf(ApiCallTimeoutError);
        expect((error as ApiCallTimeoutError).timeoutMs).toBe(300);
        expect(Date.now() - started).toBeLessThan(5_000);
        expect(server.received).toHaveLength(1);
        expect(sentOptions[0]).toMatchObject({ timeout: 10_000 });
    }, 20_000);

    it('gax 5 retries on the caller request: the retried attempt carries a REAL (non-zero) deadline', async () => {
        server.script = [FakeBehavior.RESET, FakeBehavior.OK];
        ClientRegistry.setTimeout(20_000, CallScope.api(EmailApi));

        const ref = await send(
            new ScheduleOptions(TaskName.dedup('order-8'), undefined, undefined, {
                timeout: 5_000,
                retry: { retryCodes: [grpc.status.UNAVAILABLE] },
            }),
        );

        expect(ref).toEqual(new JobReference(`${QUEUE_PARENT}/tasks/order-8`, false));
        expect(server.received).toHaveLength(2);
        expect(sentOptions).toHaveLength(1);
        // gax 4.6.1 sent min(..., 0) = a 0 ms deadline here; gax 5 bounds it by the total timeout.
        expect(server.received[1].deadlineMs).toBeGreaterThan(1_000);
    }, 20_000);
});
