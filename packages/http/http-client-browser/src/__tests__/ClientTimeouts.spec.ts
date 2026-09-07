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
import { Public, Rpc } from '@webpieces/core-util';
import { ClientConfig } from '../ClientConfig';
import { ClientHttpBrowserFactory } from '../ClientHttpBrowserFactory';
import { MutableContextStore } from '../MutableContextStore';
import { RequestLifecycleListener } from '../RequestLifecycleListener';
import { RequestOutcome } from '@webpieces/http-client-core';
class Payload {
    constructor(public readonly value = 'hello') {}
}

@Rpc()
@ApiPath('/timeout-test')
abstract class RpcApi {
    @Endpoint('/work', 'rpc')
    @Public()
    work(_request: Payload): Promise<Payload> {
        throw new Error('contract only');
    }

    @Endpoint('/other', 'rpc')
    @Public()
    other(_request: Payload): Promise<Payload> {
        throw new Error('contract only');
    }
}

class Lifecycle implements RequestLifecycleListener {
    starts = 0;
    readonly ends: RequestOutcome[] = [];
    onRequestStart(): void {
        this.starts++;
    }
    onRequestEnd(_route: object, outcome: RequestOutcome): void {
        this.ends.push(outcome);
    }
}

/** Replace only fetch; run the real factory, proxy, filters and body reader. */
class ControlledTransport {
    calls = 0;
    readonly signals: AbortSignal[] = [];
    work: () => Promise<void> = () => new Promise<void>(() => {});
    response: () => Response = () => Response.json(new Payload());
    async fetch(_url: string, options: RequestInit): Promise<Response> {
        this.calls++;
        this.signals.push(options.signal!);
        await this.work();
        return this.response();
    }
}
class Harness {
    readonly transport = new ControlledTransport();
    readonly lifecycle = new Lifecycle();
    readonly api = RpcApi;
    readonly invoke: (method?: 'work' | 'other') => Promise<object>;
    constructor() {
        vi.stubGlobal('fetch', this.transport.fetch.bind(this.transport));
        const client = new ClientHttpBrowserFactory(
            new MutableContextStore(),
            this.lifecycle,
        ).createRpcClient(RpcApi, new ClientConfig('timeout-test'));
        this.invoke = (method = 'work') => client[method](new Payload());
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

describe('browser generated client deadlines', () => {
    it('rejects at exactly 30 seconds without configuration or automatic retries', async () => {
        const h = new Harness();
        await h.expectTimeout(30_000);
        expect(h.transport.calls).toBe(1);

        expect(h.transport.signals[0].aborted).toBe(true);
        expect(h.transport.signals[0].reason).toBeInstanceOf(TimeoutError);

        expect(h.lifecycle.starts).toBe(1);
        expect(h.lifecycle.ends).toHaveLength(1);
        expect(h.lifecycle.ends[0].error).toBeInstanceOf(TimeoutError);
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

        expect(h.lifecycle.starts).toBe(1);
        expect(h.lifecycle.ends).toHaveLength(1);
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
        expect(result).toEqual(new Payload());
        finishFirst();
        await vi.advanceTimersByTimeAsync(0);
        expect(h.transport.calls).toBe(2);
        expect(vi.getTimerCount()).toBe(0);

        expect(h.transport.signals[0]).not.toBe(h.transport.signals[1]);
        expect(h.transport.signals[1].aborted).toBe(false);

        expect(h.lifecycle.ends).toHaveLength(1);
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
        await expect(h.invoke()).resolves.toEqual(new Payload());
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

describe('browser response body deadlines', () => {
    it.each([200, 503])('bounds a stalled body after HTTP %s headers', async (status: number) => {
        const h = new Harness();
        h.transport.work = () => Promise.resolve();
        let stream!: ReadableStreamDefaultController<Uint8Array>;
        h.transport.response = () =>
            new Response(
                new ReadableStream<Uint8Array>({
                    start(controller: ReadableStreamDefaultController<Uint8Array>): void {
                        stream = controller;
                    },
                }),
                { status, headers: { 'Content-Type': 'application/json' } },
            );
        await h.expectTimeout(30_000);
        stream.enqueue(new TextEncoder().encode('{}'));
        stream.close();
        await vi.advanceTimersByTimeAsync(0);

        expect(h.lifecycle.ends).toHaveLength(1);
        expect(h.lifecycle.ends[0].status).toBe(status);
    });

    it('keeps concurrent deadlines independent', async () => {
        const h = new Harness();
        CallRegistry.setTimeout(10, h.api, 'work');
        CallRegistry.setTimeout(20, h.api, 'other');
        const first = expect(h.invoke()).rejects.toBeInstanceOf(TimeoutError);
        const second = expect(h.invoke('other')).rejects.toBeInstanceOf(TimeoutError);
        await vi.advanceTimersByTimeAsync(10);
        await first;
        expect(h.transport.signals[0].aborted).toBe(true);
        expect(h.transport.signals[1].aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(10);
        await second;
        expect(vi.getTimerCount()).toBe(0);
    });
});
