import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    ApiCallTimeoutError,
    ApiConnectionError,
    ApiDependencyTimeoutError,
    ApiPath,
    ApiRetriesExhaustedError,
    AuthorizationType,
    CallMode,
    CallModeMarker,
    ClientRegistry,
    ClientRole,
    Endpoint,
    HeaderRegistry,
    POST,
    READ,
    RetryStrategy,
    RouteMetadata,
    Rpc,
    RPC,
    toError,
    WpAuthorization,
    WpAuthPublic,
    WRITE,
    WRITE_IDEMPOTENT,
    CallScope,
} from '@webpieces/core-util';
import { RequestOutcome } from '@webpieces/http-client-core';
import { ClientConfig } from '../ClientConfig';
import { ClientHttpBrowserFactory } from '../ClientHttpBrowserFactory';
import { MutableContextStore } from '../MutableContextStore';
import { RequestLifecycleListener } from '../RequestLifecycleListener';
import { ServiceWorkerRouting } from '../ServiceWorkerRouting';
import {
    ServiceWorkerSyntheticResponse,
    ServiceWorkerSyntheticResponseError,
} from '../ServiceWorkerSyntheticResponse';

class ItemsRequest {
    constructor(public readonly owner = 'dean') {}
}
class ItemsResponse {
    constructor(public readonly count = 1) {}
}

@Rpc()
@ApiPath('/items')
abstract class ItemsApi {
    @Endpoint(POST, '/list', READ, RPC)
    @WpAuthPublic('Anonymous access is intentionally required')
    @WpAuthorization({ authType: AuthorizationType.ANONYMOUS, reason: 'Anonymous access is intentionally required' })
    list(_request: ItemsRequest): Promise<ItemsResponse> {
        throw new Error('contract only');
    }

    @Endpoint(POST, '/upsert', WRITE_IDEMPOTENT, RPC)
    @WpAuthPublic('Anonymous access is intentionally required')
    @WpAuthorization({ authType: AuthorizationType.ANONYMOUS, reason: 'Anonymous access is intentionally required' })
    upsert(_request: ItemsRequest): Promise<ItemsResponse> {
        throw new Error('contract only');
    }

    @Endpoint(POST, '/create', WRITE, RPC)
    @WpAuthPublic('Anonymous access is intentionally required')
    @WpAuthorization({ authType: AuthorizationType.ANONYMOUS, reason: 'Anonymous access is intentionally required' })
    create(_request: ItemsRequest): Promise<ItemsResponse> {
        throw new Error('contract only');
    }
}

type ItemsMethod = 'list' | 'upsert' | 'create';

/** Exactly what ngsw's `Driver.safeFetch` returns when its own network fetch rejects. */
class NgswSynthetic {
    static response(): Response {
        return new Response(null, { status: 504, statusText: 'Gateway Timeout' });
    }
}

/** A real gateway 504 — it carries headers. */
class RealGateway {
    static response(): Response {
        return new Response('upstream request timeout', {
            status: 504,
            statusText: 'Gateway Timeout',
            headers: { 'Content-Type': 'text/plain', Date: 'Fri, 16 Oct 2026 08:45:10 GMT' },
        });
    }
}

class RecordingListener implements RequestLifecycleListener {
    readonly started: RouteMetadata[] = [];
    readonly ended: RequestOutcome[] = [];
    onRequestStart(route: RouteMetadata): void {
        this.started.push(route);
    }
    onRequestEnd(_route: RouteMetadata, outcome: RequestOutcome): void {
        this.ended.push(outcome);
    }
}

/** A scripted `fetch`: each call takes the next step, the last one repeating. */
class ScriptedFetch {
    readonly urls: string[] = [];
    readonly inits: RequestInit[] = [];
    constructor(private readonly steps: Array<() => Promise<Response>>) {
        vi.stubGlobal('fetch', (url: string, init: RequestInit): Promise<Response> => this.fetch(url, init));
    }
    private fetch(url: string, init: RequestInit): Promise<Response> {
        this.urls.push(url);
        this.inits.push(init);
        const step = this.steps[Math.min(this.urls.length - 1, this.steps.length - 1)];
        return step();
    }
}

class Ok {
    static step(): Promise<Response> {
        return Promise.resolve(Response.json(new ItemsResponse(3)));
    }
}
class Rejected {
    static step(): Promise<Response> {
        return Promise.reject(new TypeError('Failed to fetch'));
    }
}

class Clients {
    // webpieces-disable no-any-unknown -- a rejection value is genuinely unknown until asserted
    static failureOf(call: Promise<unknown>): Promise<Error> {
        return call.then(
            (): Error => {
                throw new Error('expected the call to reject');
            },
            // webpieces-disable no-any-unknown -- a rejection value is genuinely unknown until narrowed
            (err: unknown): Error => toError(err),
        );
    }

    static build(
        listener: RequestLifecycleListener | undefined,
        mode?: CallMode,
        serviceWorker?: ServiceWorkerRouting,
    ): ItemsApi {
        const factory = new ClientHttpBrowserFactory(new MutableContextStore(), listener);
        return factory.createRpcClient(
            ItemsApi,
            new ClientConfig('items-svc', ClientRole.END_USER_CLIENT, mode, serviceWorker),
        );
    }
}

beforeEach(() => {
    HeaderRegistry.configure([], true);
    ClientRegistry.resetForTests();
    ClientRegistry.addUrlMapping('items-svc', 'https://items.example');
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    ClientRegistry.resetForTests();
});

describe('service worker bypass (#1293)', () => {
    it('appends the ngsw-bypass QUERY parameter by default, never a header', async () => {
        const fetched = new ScriptedFetch([Ok.step]);

        await Clients.build(undefined).list(new ItemsRequest());

        expect(fetched.urls).toEqual(['https://items.example/items/list?ngsw-bypass=true']);
        const headerNames = Object.keys(fetched.inits[0].headers as Record<string, string>);
        expect(headerNames.map((key: string) => key.toLowerCase())).not.toContain('ngsw-bypass');
    });

    it('leaves the url alone when the app ALLOWs its service worker', async () => {
        const fetched = new ScriptedFetch([Ok.step]);

        await Clients.build(undefined, CallMode.FOREGROUND, ServiceWorkerRouting.ALLOW).list(new ItemsRequest());

        expect(fetched.urls).toEqual(['https://items.example/items/list']);
    });

    it('re-types ngsw synthetic 504 as ApiConnectionError with the response as cause', async () => {
        const synthetic = NgswSynthetic.response();
        new ScriptedFetch([() => Promise.resolve(synthetic)]);

        const error = await Clients.failureOf(
            Clients.build(undefined, CallMode.FOREGROUND, ServiceWorkerRouting.ALLOW).list(new ItemsRequest()),
        );

        expect(error).toBeInstanceOf(ApiConnectionError);
        expect(error).not.toBeInstanceOf(ApiDependencyTimeoutError);
        expect(error.cause).toBeInstanceOf(ServiceWorkerSyntheticResponseError);
        expect((error.cause as ServiceWorkerSyntheticResponseError).response).toBe(synthetic);
    });

    it('keeps a REAL gateway 504 (it has headers) as ApiDependencyTimeoutError', async () => {
        new ScriptedFetch([() => Promise.resolve(RealGateway.response())]);

        const error = await Clients.failureOf(Clients.build(undefined).list(new ItemsRequest()));

        expect(error).toBeInstanceOf(ApiDependencyTimeoutError);
        expect(error).not.toBeInstanceOf(ApiConnectionError);
    });

    it('recognises only the exact synthetic shape', () => {
        const detector = new ServiceWorkerSyntheticResponse();
        expect(detector.isSynthetic(NgswSynthetic.response())).toBe(true);
        expect(detector.isSynthetic(RealGateway.response())).toBe(false);
        expect(detector.isSynthetic(new Response('x', { status: 504, statusText: 'Gateway Timeout' }))).toBe(false);
        expect(detector.isSynthetic(new Response(null, { status: 503, statusText: 'Gateway Timeout' }))).toBe(false);
        expect(detector.isSynthetic(new Response(null, { status: 504, statusText: 'Timeout' }))).toBe(false);
    });

    it('a native reject under the bypass is an ApiConnectionError', async () => {
        new ScriptedFetch([Rejected.step]);

        const error = await Clients.failureOf(Clients.build(undefined).list(new ItemsRequest()));

        expect(error).toBeInstanceOf(ApiConnectionError);
    });
});

describe('per-call background marker (#1293)', () => {
    it('a BACKGROUND client hides progress and marks its failure without changing its class', async () => {
        new ScriptedFetch([Rejected.step]);
        const listener = new RecordingListener();

        const error = await Clients.failureOf(
            Clients.build(listener, CallMode.BACKGROUND).list(new ItemsRequest()),
        );

        expect(error).toBeInstanceOf(ApiConnectionError);
        expect((error as ApiConnectionError).callMode).toBe(CallMode.BACKGROUND);
        expect(CallModeMarker.of(error)).toBe(CallMode.BACKGROUND);
        expect(Object.keys(error)).not.toContain('callMode');
        expect(listener.started).toHaveLength(1);
        expect(listener.started[0].hideProgress).toBe(true);
        expect(listener.started[0].callMode).toBe(CallMode.BACKGROUND);
        expect(listener.ended).toHaveLength(1);
    });

    it('the same contract built FOREGROUND drives progress and marks FOREGROUND', async () => {
        new ScriptedFetch([Rejected.step]);
        const listener = new RecordingListener();

        const error = await Clients.failureOf(Clients.build(listener).list(new ItemsRequest()));

        expect((error as ApiConnectionError).callMode).toBe(CallMode.FOREGROUND);
        expect(listener.started[0].hideProgress).toBe(false);
        expect(listener.started[0].callMode).toBe(CallMode.FOREGROUND);
    });

    it('a BACKGROUND success still resolves normally', async () => {
        new ScriptedFetch([Ok.step]);

        await expect(Clients.build(undefined, CallMode.BACKGROUND).list(new ItemsRequest())).resolves.toEqual({
            count: 3,
        });
    });

    it('marks a deadline failure too, keeping ApiCallTimeoutError', async () => {
        vi.useFakeTimers();
        new ScriptedFetch([() => new Promise<Response>(() => {})]);
        ClientRegistry.setTimeout(50, CallScope.all());

        const pending = Clients.failureOf(Clients.build(undefined, CallMode.BACKGROUND).list(new ItemsRequest()));
        await vi.advanceTimersByTimeAsync(50);
        const error = await pending;

        expect(error).toBeInstanceOf(ApiCallTimeoutError);
        expect((error as ApiCallTimeoutError).callMode).toBe(CallMode.BACKGROUND);
    });
});

describe('stock RetryStrategy registered at ALL for a browser client (#1293)', () => {
    const strategy = new RetryStrategy(1_000, 2, 0, 1, 0);

    async function attemptsFor(method: ItemsMethod, failure: () => Promise<Response>): Promise<number> {
        const fetched = new ScriptedFetch([failure, Ok.step]);
        ClientRegistry.setStrategy(strategy.run, CallScope.all());
        const client = Clients.build(undefined, CallMode.FOREGROUND, ServiceWorkerRouting.ALLOW);
        await client[method](new ItemsRequest()).then(
            (): void => undefined,
            // webpieces-disable no-any-unknown -- a WRITE's failure is expected; only the attempt count is asserted
            (err: unknown): void => {
                expect(err).toBeInstanceOf(ApiConnectionError);
            },
        );
        return fetched.urls.length;
    }

    it('retries a connection failure on READ and WRITE_IDEMPOTENT', async () => {
        expect(await attemptsFor('list', Rejected.step)).toBe(2);
        expect(await attemptsFor('upsert', Rejected.step)).toBe(2);
    });

    it('retries ngsw synthetic 504 (now a connection failure) on READ', async () => {
        expect(await attemptsFor('list', () => Promise.resolve(NgswSynthetic.response()))).toBe(2);
    });

    it('never retries a WRITE — a dropped connection does not prove the request never left', async () => {
        expect(await attemptsFor('create', Rejected.step)).toBe(1);
    });

    it('gives up with ApiRetriesExhaustedError, still carrying the call mode', async () => {
        new ScriptedFetch([Rejected.step]);
        ClientRegistry.setStrategy(strategy.run, CallScope.all());

        const error = await Clients.failureOf(
            Clients.build(undefined, CallMode.BACKGROUND).list(new ItemsRequest()),
        );

        expect(error).toBeInstanceOf(ApiRetriesExhaustedError);
        expect(error.cause).toBeInstanceOf(ApiConnectionError);
        expect((error as ApiRetriesExhaustedError).callMode).toBe(CallMode.BACKGROUND);
    });
});
