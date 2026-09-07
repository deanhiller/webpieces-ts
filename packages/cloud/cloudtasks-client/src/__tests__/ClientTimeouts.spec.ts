import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    ApiPath,
    Attempt,
    CallContext,
    CallRegistry,
    ClientRegistry,
    Endpoint,
    HeaderRegistry,
    TimeoutError,
    toError,
} from '@webpieces/core-util';
import { PubSub, AuthOidc } from '@webpieces/core-util';
import { Provider, RequestContext, RequestContextHeaders } from '@webpieces/core-context';
import { ClientCloudTasksFactory } from '../ClientCloudTasksFactory';
import { CloudTaskScheduler } from '../CloudTaskScheduler';
import { TaskClientConfig } from '../TaskClientConfig';
import { TaskProxyClient } from '../TaskProxyClient';
import { JobReference, TaskInvoker, TaskRequest } from '../TaskTypes';
class Payload {
    constructor(public readonly value = 'hello') {}
}

@PubSub()
@AuthOidc()
@ApiPath('/timeout-task')
abstract class TaskApi {
    @Endpoint('/work', 'cloudtasks')
    work(_request: Payload): Promise<void> {
        throw new Error('contract only');
    }

    @Endpoint('/other', 'cloudtasks')
    other(_request: Payload): Promise<void> {
        throw new Error('contract only');
    }
}

class ControlledTransport extends TaskInvoker {
    calls = 0;
    readonly requests: TaskRequest[] = [];
    work: () => Promise<void> = () => new Promise<void>(() => {});
    override async enqueue(request: TaskRequest): Promise<JobReference> {
        const id = ++this.calls;
        this.requests.push(request);
        await this.work();
        return new JobReference('task-' + id);
    }
    override async delete(_ref: JobReference): Promise<void> {}
}
class Harness {
    readonly transport = new ControlledTransport();
    readonly api = TaskApi;
    readonly invoke: (method?: 'work' | 'other') => Promise<object>;
    constructor() {
        const factory = new ClientCloudTasksFactory(
            new Provider(() => new TaskProxyClient(this.transport, new RequestContextHeaders())),
        );
        const client = factory.createPubSubClient(TaskApi, new TaskClientConfig('timeout-test'));
        const scheduler = new CloudTaskScheduler(this.transport);
        this.invoke = (method = 'work') =>
            RequestContext.run(() => scheduler.addToQueue(() => client[method](new Payload())));
    }
    async expectTimeout(timeoutMs: number, method: 'work' | 'other' = 'work'): Promise<void> {
        let settled = false;
        const pending = this.invoke(method);
        const checked = expect(pending).rejects.toEqual(
            new TimeoutError(timeoutMs, new CallContext(this.api.name, method)),
        );
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
}

beforeEach(() => {
    vi.useFakeTimers();
    HeaderRegistry.configure([], true);
    CallRegistry.clear();
    ClientRegistry.clear();
    ClientRegistry.addUrlMapping('timeout-test', 'https://timeout.example');
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    CallRegistry.clear();
    ClientRegistry.clear();
});

describe('tasks generated client deadlines', () => {
    it('rejects at exactly 30 seconds without configuration or automatic retries', async () => {
        const h = new Harness();
        await h.expectTimeout(30_000);
        expect(h.transport.calls).toBe(1);
    });

    it('resolves timeout method -> API -> ALL and removes overrides with undefined', async () => {
        const h = new Harness();
        CallRegistry.setTimeout(300, 'ALL');
        CallRegistry.setTimeout(200, h.api);
        CallRegistry.setTimeout(100, h.api, 'work');
        await h.expectTimeout(100);
        await h.expectTimeout(200, 'other');
        CallRegistry.setTimeout(undefined, h.api, 'work');
        await h.expectTimeout(200);
        CallRegistry.setTimeout(undefined, h.api);
        await h.expectTimeout(300);
        CallRegistry.setTimeout(undefined, 'ALL');
        await h.expectTimeout(30_000);
    });

    it('resolves strategy method -> API -> ALL before even the most specific timeout', async () => {
        const h = new Harness();
        const seen: CallContext[] = [];
        const strategy =
            (ms: number) =>
            (call: Attempt<unknown>, ctx: CallContext): Promise<unknown> => {
                seen.push(ctx);
                return call(ms);
            };
        CallRegistry.setTimeout(1, h.api, 'work');
        CallRegistry.setStrategy(strategy(300), 'ALL');
        CallRegistry.setStrategy(strategy(200), h.api);
        CallRegistry.setStrategy(strategy(100), h.api, 'work');
        await h.expectTimeout(100);
        CallRegistry.setStrategy(undefined, h.api, 'work');
        await h.expectTimeout(200);
        CallRegistry.setStrategy(undefined, h.api);
        await h.expectTimeout(300);
        expect(seen).toEqual(Array.from({ length: 3 }, () => new CallContext(h.api.name, 'work')));
        CallRegistry.setStrategy(undefined, 'ALL');
        await h.expectTimeout(1);
    });

    it('supports 30s attempt, 60s backoff, then 20s attempt with one final error', async () => {
        const h = new Harness();
        let firstError: Error | undefined;
        CallRegistry.setTimeout(1, 'ALL');
        CallRegistry.setStrategy(async (call: Attempt<unknown>): Promise<unknown> => {
            // webpieces-disable no-unmanaged-exceptions -- application strategy retries only typed timeouts
            // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
            try {
                return await call(30_000);
            } catch (err: unknown) {
                const error = toError(err);
                if (!(error instanceof TimeoutError)) throw err;
                firstError = error;
                await new Promise<void>((resolve: () => void) => setTimeout(resolve, 60_000));
                return call(20_000);
            }
        }, h.api);
        const pending = h.invoke();
        const checked = expect(pending).rejects.toEqual(
            new TimeoutError(20_000, new CallContext(h.api.name, 'work')),
        );
        await vi.advanceTimersByTimeAsync(30_000);
        expect(firstError).toBeInstanceOf(TimeoutError);
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
        CallRegistry.setStrategy(
            async (call: Attempt<unknown>): Promise<unknown> =>
                call(10).catch((err: Error) => {
                    expect(err).toBeInstanceOf(TimeoutError);
                    h.transport.work = () => Promise.resolve();
                    return call(20);
                }),
            h.api,
        );
        const pending = h.invoke();
        await vi.advanceTimersByTimeAsync(10);
        const result = await pending;
        expect(result).toEqual(new JobReference('task-2'));
        finishFirst();
        await vi.advanceTimersByTimeAsync(0);
        expect(h.transport.calls).toBe(2);
        expect(vi.getTimerCount()).toBe(0);

        expect(h.transport.requests[0]).not.toBe(h.transport.requests[1]);
    });

    it('passes strategy exceptions through by identity, including non-Error values', async () => {
        const h = new Harness();
        for (const failure of [new Error('business failure'), new Payload('sentinel')]) {
            CallRegistry.setStrategy(() => Promise.reject(failure), h.api);
            await expect(h.invoke()).rejects.toBe(failure);
        }
        expect(h.transport.calls).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('does not retry real transport failures and cleans the timer', async () => {
        const h = new Harness();
        const failure = new Error('real failure');
        h.transport.work = () => Promise.reject(failure);
        await expect(h.invoke()).rejects.toBe(failure);
        expect(h.transport.calls).toBe(1);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('cleans the default timer on success', async () => {
        const h = new Harness();
        h.transport.work = () => Promise.resolve();
        await expect(h.invoke()).resolves.toEqual(new JobReference('task-1'));
        expect(vi.getTimerCount()).toBe(0);
    });

    it.each([0, -1, NaN, Infinity, 2_147_483_648])(
        'rejects an invalid strategy timeout %s before sending',
        async (ms: number) => {
            const h = new Harness();
            CallRegistry.setStrategy((call: Attempt<unknown>) => call(ms), h.api);
            await expect(h.invoke()).rejects.toBeInstanceOf(RangeError);
            expect(h.transport.calls).toBe(0);
            expect(vi.getTimerCount()).toBe(0);
        },
    );

    it('bounds hung URL resolution and never sends after it resolves late', async () => {
        const h = new Harness();
        ClientRegistry.clear();
        let resolveUrl!: (url: string) => void;
        ClientRegistry.setDeriver(
            () =>
                new Promise<string>((resolve: (url: string) => void) => {
                    resolveUrl = resolve;
                }),
        );
        await h.expectTimeout(30_000);
        expect(h.transport.calls).toBe(0);
        resolveUrl('https://late.example');
        await vi.advanceTimersByTimeAsync(0);
        expect(h.transport.calls).toBe(0);
    });
});
