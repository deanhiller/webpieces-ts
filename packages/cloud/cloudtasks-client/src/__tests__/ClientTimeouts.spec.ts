import { WpAuthorization, AuthorizationType, WpAuth, oidcSameProject, CallScope } from '@webpieces/core-util';
import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    ApiPath,
    ApiRetriesExhaustedError,
    ApiUnavailableError,
    Attempt,
    CallContext,
    ClientRegistry,
    Endpoint,
    HeaderRegistry,
    ApiCallTimeoutError,
    ApiCallSite,
    RetryStrategy,
    toError,
    CLOUDTASKS,
    POST,
    WRITE,
    WRITE_IDEMPOTENT,
} from '@webpieces/core-util';
import { PubSub } from '@webpieces/core-util';
import { Provider, RequestContext, RequestContextHeaders } from '@webpieces/core-context';
import { ClientCloudTasksFactory } from '../ClientCloudTasksFactory';
import { CloudTaskScheduler, ScheduleOptions } from '../CloudTaskScheduler';
import { TaskClientConfig } from '../TaskClientConfig';
import { TaskProxyClient } from '../TaskProxyClient';
import { TaskName } from '../TaskName';
import { GcpTaskRegistry } from '../GcpTaskRegistry';
import { TaskAlreadyExistsError } from '../TaskAlreadyExistsError';
import { JobReference, TaskInvoker, TaskRequest } from '../TaskTypes';
class Payload {
    constructor(public readonly value = 'hello') {}
}

@PubSub()
@ApiPath('/timeout-task')
abstract class TaskApi {
    @WpAuth([oidcSameProject()])
    @WpAuthorization({ authType: AuthorizationType.SERVICE_ONLY })
    @Endpoint(POST, '/work', WRITE, CLOUDTASKS)
    work(_request: Payload): Promise<void> {
        throw new Error('contract only');
    }

    @WpAuth([oidcSameProject()])
    @WpAuthorization({ authType: AuthorizationType.SERVICE_ONLY })
    @Endpoint(POST, '/other', WRITE, CLOUDTASKS)
    other(_request: Payload): Promise<void> {
        throw new Error('contract only');
    }
}

class ControlledTransport extends TaskInvoker {
    calls = 0;
    readonly requests: TaskRequest[] = [];
    readonly timeouts: number[] = [];
    work: () => Promise<void> = () => new Promise<void>(() => {});
    override async enqueue(request: TaskRequest, timeoutMs: number): Promise<JobReference> {
        const id = ++this.calls;
        this.requests.push(request);
        this.timeouts.push(timeoutMs);
        await this.work();
        return new JobReference('task-' + id, false);
    }
    override async delete(_ref: JobReference): Promise<void> {}
}

/** Enqueue is WRITE_IDEMPOTENT in every naming mode: one name for every attempt. */
const ctx = (method: 'work' | 'other'): CallContext =>
    new CallContext(TaskApi.name, method, WRITE_IDEMPOTENT, TaskApi);

class Harness {
    readonly transport = new ControlledTransport();
    readonly api = TaskApi;
    readonly invoke: (method?: 'work' | 'other', opts?: ScheduleOptions) => Promise<JobReference>;
    constructor() {
        const factory = new ClientCloudTasksFactory(
            new Provider(() => new TaskProxyClient(this.transport, new RequestContextHeaders())),
        );
        const client = factory.createPubSubClient(TaskApi, new TaskClientConfig('timeout-test'));
        const scheduler = new CloudTaskScheduler(this.transport);
        this.invoke = (method = 'work', opts?: ScheduleOptions) =>
            RequestContext.run(() => scheduler.addToQueue(() => client[method](new Payload()), opts));
    }
    async expectTimeout(timeoutMs: number, method: 'work' | 'other' = 'work'): Promise<void> {
        let settled = false;
        const pending = this.invoke(method);
        const checked = expect(pending).rejects.toEqual(new ApiCallTimeoutError(timeoutMs, ctx(method)));
        void pending.then(
            () => {
                settled = true;
            },
            () => {
                settled = true;
            },
        );
        await vi.advanceTimersByTimeAsync(timeoutMs - 1);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await checked;
        expect(vi.getTimerCount()).toBe(0);
    }

    /**
     * The enqueue default, unconfigured: RetryStrategy(5_000, 3, 500, 2, 4_000) — 4 attempts of 5 s
     * with 500 / 1000 / 2000 ms between them, then ApiRetriesExhaustedError at exactly 23.5 s.
     */
    async expectDefaultRetriesExhausted(): Promise<ApiRetriesExhaustedError> {
        let failure: Error | undefined;
        const pending = this.invoke().catch((err: unknown) => {
            const error = toError(err);
            failure = error;
            return undefined;
        });
        await vi.advanceTimersByTimeAsync(23_499);
        expect(failure).toBeUndefined();
        await vi.advanceTimersByTimeAsync(1);
        await pending;
        expect(failure).toBeInstanceOf(ApiRetriesExhaustedError);
        expect(vi.getTimerCount()).toBe(0);
        return failure as ApiRetriesExhaustedError;
    }
}

beforeEach(() => {
    vi.useFakeTimers();
    HeaderRegistry.configure([], true);
    ClientRegistry.resetForTests();
    GcpTaskRegistry.clear();
    ClientRegistry.addUrlMapping('timeout-test', 'https://timeout.example');
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    ClientRegistry.resetForTests();
    GcpTaskRegistry.clear();
});

describe('tasks generated client deadlines — Path A, webpieces owns timing', () => {
    it('with no configuration runs the enqueue RetryStrategy: 4 x 5 s attempts, then retries-exhausted', async () => {
        const h = new Harness();
        const exhausted = await h.expectDefaultRetriesExhausted();
        expect(h.transport.timeouts).toEqual([5_000, 5_000, 5_000, 5_000]);
        expect(exhausted.attempts).toBe(4);
        expect(exhausted.lastError).toEqual(new ApiCallTimeoutError(5_000, ctx('work')));
        // Every attempt carries the SAME name: resolved once, before the first attempt.
        const names = new Set(h.transport.requests.map((request: TaskRequest) => request.plan.taskId));
        expect(names.size).toBe(1);
        expect([...names][0]).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('retries a transient transport failure and returns the next attempt', async () => {
        const h = new Harness();
        let first = true;
        h.transport.work = () => {
            if (!first) return Promise.resolve();
            first = false;
            return Promise.reject(new ApiUnavailableError('connection reset'));
        };
        const pending = h.invoke();
        await vi.advanceTimersByTimeAsync(500);
        await expect(pending).resolves.toEqual(new JobReference('task-2', false));
        expect(h.transport.requests[0].plan.taskId).toBe(h.transport.requests[1].plan.taskId);
    });

    it('resolves timeout method -> API -> ALL; a registered timeout is a single attempt', async () => {
        const h = new Harness();
        ClientRegistry.setTimeout(300, CallScope.all());
        ClientRegistry.setTimeout(200, CallScope.api(h.api));
        ClientRegistry.setTimeout(100, CallScope.method(h.api, 'work'));
        await h.expectTimeout(100);
        await h.expectTimeout(200, 'other');
        ClientRegistry.setTimeout(undefined, CallScope.method(h.api, 'work'));
        await h.expectTimeout(200);
        ClientRegistry.setTimeout(undefined, CallScope.api(h.api));
        await h.expectTimeout(300);
        ClientRegistry.setTimeout(undefined, CallScope.all());
        await h.expectDefaultRetriesExhausted();
    });

    it('resolves strategy method -> API -> ALL before even the most specific timeout', async () => {
        const h = new Harness();
        const seen: CallContext[] = [];
        const strategy =
            (ms: number) =>
            (call: Attempt<unknown>, context: CallContext): Promise<unknown> => {
                seen.push(context);
                return call(ms);
            };
        ClientRegistry.setTimeout(1, CallScope.method(h.api, 'work'));
        ClientRegistry.setStrategy(strategy(300), CallScope.all());
        ClientRegistry.setStrategy(strategy(200), CallScope.api(h.api));
        ClientRegistry.setStrategy(strategy(100), CallScope.method(h.api, 'work'));
        await h.expectTimeout(100);
        ClientRegistry.setStrategy(undefined, CallScope.method(h.api, 'work'));
        await h.expectTimeout(200);
        ClientRegistry.setStrategy(undefined, CallScope.api(h.api));
        await h.expectTimeout(300);
        expect(seen).toEqual(Array.from({ length: 3 }, () => ctx('work')));
        ClientRegistry.setStrategy(undefined, CallScope.all());
        await h.expectTimeout(1);
    });

    it('tunes OUR retries per API with a registered RetryStrategy', async () => {
        const h = new Harness();
        ClientRegistry.setStrategy(new RetryStrategy(1_000, 1, 100, 2, 100).run, CallScope.api(h.api));
        let failure: Error | undefined;
        const pending = h.invoke().catch((err: unknown) => {
            const error = toError(err);
            failure = error;
            return undefined;
        });
        await vi.advanceTimersByTimeAsync(2_100);
        await pending;
        expect(failure).toBeInstanceOf(ApiRetriesExhaustedError);
        expect(h.transport.timeouts).toEqual([1_000, 1_000]);
    });

    it('supports 30s attempt, 60s backoff, then 20s attempt with one final error', async () => {
        const h = new Harness();
        let firstError: Error | undefined;
        ClientRegistry.setTimeout(1, CallScope.all());
        ClientRegistry.setStrategy(async (call: Attempt<unknown>): Promise<unknown> => {
            // webpieces-disable no-unmanaged-exceptions -- application strategy retries only typed timeouts
            // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
            try {
                return await call(30_000);
            } catch (err: unknown) {
                const error = toError(err);
                if (!(error instanceof ApiCallTimeoutError)) throw err;
                firstError = error;
                await new Promise<void>((resolve: () => void) => setTimeout(resolve, 60_000));
                return call(20_000);
            }
        }, CallScope.api(h.api));
        const pending = h.invoke();
        const checked = expect(pending).rejects.toEqual(new ApiCallTimeoutError(20_000, ctx('work')));
        await vi.advanceTimersByTimeAsync(30_000);
        expect(firstError).toBeInstanceOf(ApiCallTimeoutError);
        expect(h.transport.calls).toBe(1);
        await vi.advanceTimersByTimeAsync(59_999);
        expect(h.transport.calls).toBe(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(h.transport.calls).toBe(2);
        await vi.advanceTimersByTimeAsync(20_000);
        await checked;
        expect(vi.getTimerCount()).toBe(0);
    });

    it('returns the successful retry and ignores a late first attempt', async () => {
        const h = new Harness();
        let finishFirst!: () => void;
        h.transport.work = () =>
            new Promise<void>((resolve: () => void) => {
                finishFirst = resolve;
            });
        ClientRegistry.setStrategy(
            async (call: Attempt<unknown>): Promise<unknown> =>
                call(10).catch((err: Error) => {
                    expect(err).toBeInstanceOf(ApiCallTimeoutError);
                    h.transport.work = () => Promise.resolve();
                    return call(20);
                }),
            CallScope.api(h.api),
        );
        const pending = h.invoke();
        await vi.advanceTimersByTimeAsync(10);
        const result = await pending;
        expect(result).toEqual(new JobReference('task-2', false));
        finishFirst();
        await vi.advanceTimersByTimeAsync(0);
        expect(h.transport.calls).toBe(2);
        expect(vi.getTimerCount()).toBe(0);

        expect(h.transport.requests[0]).not.toBe(h.transport.requests[1]);
    });

    it('passes strategy exceptions through by identity, including non-Error values', async () => {
        const h = new Harness();
        for (const failure of [new Error('business failure'), new Payload('sentinel')]) {
            ClientRegistry.setStrategy(() => Promise.reject(failure), CallScope.api(h.api));
            await expect(h.invoke()).rejects.toBe(failure);
        }
        expect(h.transport.calls).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('does not retry a non-transient transport failure and cleans the timer', async () => {
        const h = new Harness();
        const failure = new Error('real failure');
        h.transport.work = () => Promise.reject(failure);
        await expect(h.invoke()).rejects.toBe(failure);
        expect(h.transport.calls).toBe(1);
        expect(vi.getTimerCount()).toBe(0);
        // #1175: the SAME instance carries where the app enqueued it, non-enumerably.
        expect(ApiCallSite.of(failure)?.label).toBe('TaskApi.work');
        expect(Object.keys(failure)).not.toContain('callSite');
    });

    it('cleans the default timer on success', async () => {
        const h = new Harness();
        h.transport.work = () => Promise.resolve();
        await expect(h.invoke()).resolves.toEqual(new JobReference('task-1', false));
        expect(vi.getTimerCount()).toBe(0);
    });

    it.each([0, -1, NaN, Infinity, 2_147_483_648])(
        'rejects an invalid strategy timeout %s before sending',
        async (ms: number) => {
            const h = new Harness();
            ClientRegistry.setStrategy((call: Attempt<unknown>) => call(ms), CallScope.api(h.api));
            await expect(h.invoke()).rejects.toBeInstanceOf(RangeError);
            expect(h.transport.calls).toBe(0);
            expect(vi.getTimerCount()).toBe(0);
        },
    );

    it('bounds hung URL resolution and never sends after it resolves late', async () => {
        const h = new Harness();
        ClientRegistry.resetForTests();
        let resolveUrl!: (url: string) => void;
        ClientRegistry.setDeriver(
            () =>
                new Promise<string>((resolve: (url: string) => void) => {
                    resolveUrl = resolve;
                }),
        );
        await h.expectDefaultRetriesExhausted();
        expect(h.transport.calls).toBe(0);
        resolveUrl('https://late.example');
        await vi.advanceTimersByTimeAsync(0);
        expect(h.transport.calls).toBe(0);
    });
});

describe('tasks generated client — Path B, the caller owns timing (gax set)', () => {
    it('makes exactly ONE attempt under the 30 s safety cap, ignoring every registered strategy', async () => {
        const h = new Harness();
        ClientRegistry.setStrategy(new RetryStrategy(1_000, 5, 1, 1, 1).run, CallScope.all());
        h.transport.work = () => Promise.reject(new ApiUnavailableError('reset'));
        const opts = new ScheduleOptions(TaskName.dedup('order-1'), undefined, undefined, { timeout: 10_000 });
        await expect(h.invoke('work', opts)).rejects.toBeInstanceOf(ApiUnavailableError);
        expect(h.transport.timeouts).toEqual([30_000]);
        expect(h.transport.requests[0].plan.gax).toEqual({ timeout: 10_000 });
    });

    it('the safety cap follows the timeout ladder and holds on a hung transport', async () => {
        const h = new Harness();
        GcpTaskRegistry.setGax({ timeout: 10_000 }, CallScope.method(h.api, 'work'));
        ClientRegistry.setTimeout(300, CallScope.api(h.api));
        await h.expectTimeout(300);
        expect(h.transport.calls).toBe(1);
        expect(h.transport.timeouts).toEqual([300]);
    });
});

describe('tasks generated client — ALREADY_EXISTS', () => {
    it('is success with alreadyExisted, caught above the retry layer', async () => {
        const h = new Harness();
        let calls = 0;
        h.transport.work = () => {
            calls += 1;
            return calls === 1
                ? Promise.reject(new ApiUnavailableError('reset after the task landed'))
                : Promise.reject(new TaskAlreadyExistsError('projects/p/locations/l/queues/q/tasks/order-9'));
        };
        const pending = h.invoke('work', new ScheduleOptions(TaskName.dedup('order-9')));
        await vi.advanceTimersByTimeAsync(500);
        await expect(pending).resolves.toEqual(
            new JobReference('projects/p/locations/l/queues/q/tasks/order-9', true),
        );
        expect(h.transport.calls).toBe(2);
    });
});
