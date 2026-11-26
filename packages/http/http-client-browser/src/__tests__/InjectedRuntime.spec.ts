import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    ApiCallTimeoutError,
    ApiConnectionError,
    ApiJsonSchema,
    ApiPath,
    AuthorizationType,
    CallContext,
    CallScope,
    ClientRegistry,
    ClientRole,
    ContextKey,
    Endpoint,
    HeaderRegistry,
    ObjectSchemaBuilder,
    POST,
    READ,
    ResponseStream,
    RetryStrategy,
    RPC,
    Rpc,
    StreamDirection,
    StreamWriter,
    WRITE,
    WpAuthPublic,
    WpAuthorization,
    WpStream,
    registerStreamingSchemas,
    toError,
} from '@webpieces/core-util';
import {
    HttpClientRuntime,
    HttpFetch,
    HttpFetchInit,
    ReactNativeRuntimeConfigError,
    MobileWebViewHost,
    MobileWebViewRuntimeConfigError,
    RequestOutcome,
} from '@webpieces/http-client-core';
import { ClientConfig } from '../ClientConfig';
import { ClientHttpBrowserFactory } from '../ClientHttpBrowserFactory';
import { MutableContextStore } from '../MutableContextStore';
import { RequestLifecycleListener } from '../RequestLifecycleListener';
import {
    FakeNativeTimerModule,
    ManualDeadline,
    ManualDeadlines,
    NativeDeadlineScheduler,
} from './fixtures/NativeDeadlineScheduler';

/**
 * #1445 feature tests: the factory's injected runtime (fetch + deadline clock) carries EVERY request
 * through the real factory, proxy, filter chain, serializer, body reader and error translation; the
 * React Native runtime is refused at construction when it is not configured; and the deadline holds
 * while ordinary JS timers are frozen, which is what a locked Android phone does to them.
 *
 * Edges only: the transport (an injected fetch the test scripts), the clock (a scheduler the test
 * fires), and the runtime globals (`navigator`, `fetch`, `ReactNativeWebView`).
 */

class Payload {
    constructor(public readonly value = 'hello') {}
}

@Rpc()
@ApiPath('/runtime')
abstract class RuntimeApi {
    @Endpoint(POST, '/read', READ, RPC)
    @WpAuthPublic('runtime injection fixture')
    @WpAuthorization({ authType: AuthorizationType.ANONYMOUS, reason: 'runtime injection fixture' })
    read(_request: Payload): Promise<Payload> {
        throw new Error('contract only');
    }

    @Endpoint(POST, '/write', WRITE, RPC)
    @WpAuthPublic('runtime injection fixture')
    @WpAuthorization({ authType: AuthorizationType.ANONYMOUS, reason: 'runtime injection fixture' })
    write(_request: Payload): Promise<Payload> {
        throw new Error('contract only');
    }
}

class StreamInput {
    value!: string;
}
class StreamOutput {
    result!: string;
}
const inputSchema = new ObjectSchemaBuilder()
    .required('value', new ApiJsonSchema('string'))
    .build();
const outputSchema = new ObjectSchemaBuilder()
    .required('result', new ApiJsonSchema('string'))
    .build();

@Rpc()
@ApiPath('/runtime-stream')
abstract class RuntimeStreamApi {
    @Endpoint(POST, '/watch', READ, RPC)
    @WpAuthPublic('runtime injection fixture')
    @WpAuthorization({ authType: AuthorizationType.ANONYMOUS, reason: 'runtime injection fixture' })
    @WpStream(StreamDirection.RESPONSE)
    watch(_request: StreamInput, _response: ResponseStream<StreamOutput>): Promise<StreamOutput> {
        throw new Error('contract only');
    }
}
registerStreamingSchemas(RuntimeStreamApi, 'watch', {
    initialRequestSchema: inputSchema,
    initialResponseSchema: outputSchema,
    responseSchema: outputSchema,
});

const TENANT = ContextKey.untrusted<string>('tenantId', 'x-tenant-id');

/** One request the injected transport received, exactly as the client handed it over. */
class Sent {
    constructor(
        readonly url: string,
        readonly init: HttpFetchInit,
    ) {}
}

/** The transport EDGE: an application-supplied fetch whose answers the test scripts. */
class ScriptedTransport {
    readonly sent: Sent[] = [];
    respond: (init: HttpFetchInit) => Promise<Response> = () =>
        Promise.resolve(Response.json(new Payload('from-transport')));

    readonly fetch: HttpFetch = (url: string, init: HttpFetchInit): Promise<Response> => {
        this.sent.push(new Sent(url, init));
        return this.respond(init);
    };
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

/** A React Native client wired exactly as an app would: the example native adapter + a transport. */
class NativeHarness {
    readonly native = new FakeNativeTimerModule();
    readonly scheduler = new NativeDeadlineScheduler(this.native);
    readonly lifecycle = new Lifecycle();
    readonly client: RuntimeApi;

    constructor(readonly transport: ScriptedTransport) {
        this.client = new ClientHttpBrowserFactory(
            new MutableContextStore(),
            this.lifecycle,
            HttpClientRuntime.reactNative(transport.fetch, this.scheduler),
        ).createRpcClient(RuntimeApi, config());
    }

    /** Native fires the first armed timer, delivering through the app's event listener. */
    fireFirst(): void {
        this.scheduler.deliver(this.native.starts[0].id);
    }
}

/** A transport that never answers and ignores its abort signal — the worst case the deadline bounds. */
const neverAnswers = (): Promise<Response> => new Promise<Response>(() => undefined);

const delays = (deadlines: ManualDeadlines): number[] =>
    deadlines.scheduled.map((deadline: ManualDeadline): number => deadline.delayMs);

/** Let promise continuations run without touching any (possibly frozen) JS timer. */
async function settle(): Promise<void> {
    for (let i = 0; i < 50; i++) await Promise.resolve();
}

function config(): ClientConfig {
    return new ClientConfig('runtime-svc', ClientRole.END_USER_CLIENT);
}

function manualClient(transport: ScriptedTransport, deadlines: ManualDeadlines): RuntimeApi {
    return new ClientHttpBrowserFactory(
        new MutableContextStore(),
        undefined,
        HttpClientRuntime.reactNative(transport.fetch, deadlines),
    ).createRpcClient(RuntimeApi, config());
}

let globalFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
    HeaderRegistry.configure([TENANT], true);
    ClientRegistry.resetForTests();
    ClientRegistry.addUrlMapping('runtime-svc', 'https://api.example');
    globalFetch = vi.fn(() => Promise.resolve(Response.json(new Payload('from-global'))));
    vi.stubGlobal('fetch', globalFetch);
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    ClientRegistry.resetForTests();
});

describe('runtime selection at factory creation', () => {
    it('a plain browser keeps the platform fetch with no runtime argument', async () => {
        vi.stubGlobal('navigator', { product: 'Gecko' });
        const client = new ClientHttpBrowserFactory(new MutableContextStore()).createRpcClient(
            RuntimeApi,
            config(),
        );
        await expect(client.read(new Payload())).resolves.toEqual(new Payload('from-global'));
        expect(globalFetch).toHaveBeenCalledTimes(1);
    });

    it('an undeclared WebView refuses browser defaults before any request', () => {
        vi.stubGlobal('navigator', { product: 'Gecko' });
        vi.stubGlobal('ReactNativeWebView', { postMessage: (): void => undefined });
        vi.stubGlobal('window', globalThis);
        expect(() => new ClientHttpBrowserFactory(new MutableContextStore())).toThrow(
            MobileWebViewRuntimeConfigError,
        );
        expect(globalFetch).not.toHaveBeenCalled();
    });

    it.each([
        ['no navigator at all (Node / SSR)', undefined],
        ['a navigator without product (worker)', {}],
        ['a null navigator', null],
    ])('%s is safe and keeps the defaults', async (_name: string, navigator: unknown) => {
        vi.stubGlobal('navigator', navigator);
        const client = new ClientHttpBrowserFactory(new MutableContextStore()).createRpcClient(
            RuntimeApi,
            config(),
        );
        await expect(client.read(new Payload())).resolves.toEqual(new Payload('from-global'));
    });

    it('the React Native runtime without a runtime argument is refused before any request', () => {
        vi.stubGlobal('navigator', { product: 'ReactNative' });
        let thrown: Error | undefined;
        // webpieces-disable no-unmanaged-exceptions -- capturing the construction failure under test
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            new ClientHttpBrowserFactory(new MutableContextStore());
        } catch (err: unknown) {
            const error = toError(err);
            thrown = error;
        }
        expect(thrown).toBeInstanceOf(ReactNativeRuntimeConfigError);
        const error = thrown as ReactNativeRuntimeConfigError;
        expect(error.missing).toEqual(['fetch', 'deadlines']);
        expect(error.message).toContain('missing: fetch, deadlines');
        expect(error.message).toContain('HttpClientRuntime.reactNative(fetch, deadlines)');
        expect(error.message).toContain(ReactNativeRuntimeConfigError.SETUP_URL);
        expect(globalFetch).not.toHaveBeenCalled();
    });

    it('the React Native runtime refuses explicitly passed platform defaults too', () => {
        vi.stubGlobal('navigator', { product: 'ReactNative' });
        expect(
            () =>
                new ClientHttpBrowserFactory(
                    new MutableContextStore(),
                    undefined,
                    HttpClientRuntime.platformDefaults(),
                ),
        ).toThrow(ReactNativeRuntimeConfigError);
    });

    it('a declared React Native runtime names each missing collaborator (untyped JS callers)', () => {
        const deadlines = new ManualDeadlines();
        const transport = new ScriptedTransport();
        const missingFetch = (): HttpClientRuntime =>
            HttpClientRuntime.reactNative(undefined as unknown as HttpFetch, deadlines);
        const missingDeadlines = (): HttpClientRuntime =>
            HttpClientRuntime.reactNative(transport.fetch, undefined as unknown as ManualDeadlines);
        const missingBoth = (): HttpClientRuntime =>
            HttpClientRuntime.reactNative(
                undefined as unknown as HttpFetch,
                new Payload() as unknown as ManualDeadlines,
            );
        expect(missingFetch).toThrow(/missing: fetch\. /);
        expect(missingDeadlines).toThrow(/missing: deadlines\. /);
        expect(missingBoth).toThrow(/missing: fetch, deadlines\. /);
        expect(transport.sent).toHaveLength(0);
    });

    it('a configured React Native runtime is accepted when the marker is present', async () => {
        vi.stubGlobal('navigator', { product: 'ReactNative' });
        const transport = new ScriptedTransport();
        const client = manualClient(transport, new ManualDeadlines());
        await expect(client.read(new Payload())).resolves.toEqual(new Payload('from-transport'));
        expect(globalFetch).not.toHaveBeenCalled();
    });
});

describe('the injected fetch carries the whole request', () => {
    it('receives the exact URL and options; the global fetch is never called', async () => {
        const store = new MutableContextStore();
        store.set(TENANT, 'tenant-7');
        const transport = new ScriptedTransport();
        const lifecycle = new Lifecycle();
        const client = new ClientHttpBrowserFactory(
            store,
            lifecycle,
            HttpClientRuntime.reactNative(transport.fetch, new ManualDeadlines()),
        ).createRpcClient(RuntimeApi, config());

        await expect(client.write(new Payload('sent'))).resolves.toEqual(
            new Payload('from-transport'),
        );

        expect(globalFetch).not.toHaveBeenCalled();
        expect(transport.sent).toHaveLength(1);
        const sent = transport.sent[0];
        expect(sent.url).toBe('https://api.example/runtime/write?ngsw-bypass=true');
        expect(sent.init).toBeInstanceOf(HttpFetchInit);
        expect(sent.init.method).toBe('POST');
        expect(sent.init.redirect).toBe('follow');
        expect(sent.init.body).toBe(JSON.stringify(new Payload('sent')));
        expect(sent.init.headers['x-tenant-id']).toBe('tenant-7');
        expect(sent.init.signal.aborted).toBe(false);
        expect(lifecycle.starts).toBe(1);
        expect(lifecycle.ends).toHaveLength(1);
        expect(lifecycle.ends[0].ok).toBe(true);
        expect(lifecycle.ends[0].status).toBe(200);
    });

    it('two factories use their own transports independently', async () => {
        const first = new ScriptedTransport();
        const second = new ScriptedTransport();
        second.respond = () => Promise.resolve(Response.json(new Payload('second')));
        const clientA = manualClient(first, new ManualDeadlines());
        const clientB = manualClient(second, new ManualDeadlines());

        await expect(clientA.read(new Payload())).resolves.toEqual(new Payload('from-transport'));
        await expect(clientB.read(new Payload())).resolves.toEqual(new Payload('second'));
        expect(first.sent).toHaveLength(1);
        expect(second.sent).toHaveLength(1);
        expect(globalFetch).not.toHaveBeenCalled();
    });

    it('translates an error response exactly as the platform fetch path does', async () => {
        const failing = (): Promise<Response> =>
            Promise.resolve(new Response('upstream exploded', { status: 500 }));
        globalFetch.mockImplementation(failing);
        const viaGlobal = await new ClientHttpBrowserFactory(new MutableContextStore())
            .createRpcClient(RuntimeApi, config())
            .read(new Payload())
            .catch((err: unknown) => err);

        const transport = new ScriptedTransport();
        transport.respond = failing;
        const viaInjected = await manualClient(transport, new ManualDeadlines())
            .read(new Payload())
            .catch((err: unknown) => err);

        expect(viaInjected).toBeInstanceOf(Error);
        expect((viaInjected as Error).constructor).toBe((viaGlobal as Error).constructor);
        expect((viaInjected as Error).message).toBe((viaGlobal as Error).message);
    });

    it('classifies a native network reject into ApiConnectionError, even a synchronous throw', async () => {
        const networkError = new TypeError('Network request failed');
        const deadlines = new ManualDeadlines();
        const transport = new ScriptedTransport();
        transport.respond = () => {
            throw networkError;
        };

        const error = await manualClient(transport, deadlines)
            .read(new Payload())
            .catch((err: unknown) => err);

        expect(error).toBeInstanceOf(ApiConnectionError);
        expect((error as ApiConnectionError).cause).toBe(networkError);
        expect(deadlines.scheduled).toHaveLength(1);
        expect(deadlines.scheduled[0].cancelCount).toBe(1);
    });

    it('a response-streaming handshake goes through the injected fetch too', async () => {
        const encoder = new TextEncoder();
        const transport = new ScriptedTransport();
        transport.respond = () =>
            Promise.resolve(
                new Response(
                    new ReadableStream<Uint8Array>({
                        start(controller: ReadableStreamDefaultController<Uint8Array>): void {
                            controller.enqueue(
                                encoder.encode('{"result":"accepted"}\n{"result":"event"}\n'),
                            );
                            controller.close();
                        },
                    }),
                    { status: 200, headers: { 'content-type': 'application/x-webpieces-jsonl' } },
                ),
            );
        const client = new ClientHttpBrowserFactory(
            new MutableContextStore(),
            undefined,
            HttpClientRuntime.reactNative(transport.fetch, new ManualDeadlines()),
        ).createRpcClient(RuntimeStreamApi, config());
        const received: StreamOutput[] = [];
        const responses = new StreamWriter<StreamOutput>(async (envelope): Promise<void> => {
            if (envelope.value) received.push(envelope.value);
        });

        await expect(client.watch({ value: 'open' }, responses)).resolves.toEqual({
            result: 'accepted',
        });
        await vi.waitFor(() => expect(received).toEqual([{ result: 'event' }]));
        expect(transport.sent).toHaveLength(1);
        expect(transport.sent[0].url).toBe(
            'https://api.example/runtime-stream/watch?ngsw-bypass=true',
        );
        expect(globalFetch).not.toHaveBeenCalled();
    });
});

describe('the injected deadline while ordinary JS timers are frozen', () => {
    beforeEach(() => {
        // A locked Android phone: JS timers stop. They are faked and NEVER advanced in this block,
        // so any deadline that still fires was delivered through the injected scheduler.
        vi.useFakeTimers({
            toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
        });
    });

    it('a native-delivered deadline rejects a stalled transport that ignores abort', async () => {
        const transport = new ScriptedTransport();
        transport.respond = neverAnswers;
        const h = new NativeHarness(transport);

        const outcome = h.client.write(new Payload()).catch((err: unknown) => err);
        await settle();
        expect(h.native.starts.map((start: { delayMs: number }): number => start.delayMs)).toEqual([
            30_000,
        ]);
        expect(vi.getTimerCount()).toBe(0);

        h.fireFirst();

        expect(await outcome).toEqual(
            new ApiCallTimeoutError(
                30_000,
                new CallContext('RuntimeApi', 'write', WRITE, RuntimeApi),
            ),
        );
        expect(transport.sent[0].init.signal.aborted).toBe(true);
        expect(h.lifecycle.ends).toHaveLength(1);
        expect(h.lifecycle.ends[0].error).toBeInstanceOf(ApiCallTimeoutError);
        // Fired, so already released: no redundant cancel crosses the bridge.
        expect(h.native.cancels).toEqual([]);
    });

    it('bounds a response body that never finishes after its headers arrived', async () => {
        const transport = new ScriptedTransport();
        transport.respond = () =>
            Promise.resolve(
                new Response(new ReadableStream<Uint8Array>({ start: (): void => undefined }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }),
            );
        const h = new NativeHarness(transport);

        const outcome = h.client.read(new Payload()).catch((err: unknown) => err);
        await settle();
        h.fireFirst();

        expect(await outcome).toBeInstanceOf(ApiCallTimeoutError);
        expect(h.lifecycle.ends[0].status).toBe(200);
    });

    it('a successful call cancels its native deadline exactly once', async () => {
        const h = new NativeHarness(new ScriptedTransport());

        await expect(h.client.read(new Payload())).resolves.toEqual(new Payload('from-transport'));

        expect(h.native.starts).toHaveLength(1);
        expect(h.native.cancels).toEqual([h.native.starts[0].id]);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('a result that arrives after the budget, with no native delivery, is a timeout on resumption', async () => {
        let answer!: (response: Response) => void;
        const transport = new ScriptedTransport();
        transport.respond = () =>
            new Promise<Response>((resolve: (response: Response) => void) => {
                answer = resolve;
            });
        const h = new NativeHarness(transport);

        const outcome = h.client.read(new Payload()).catch((err: unknown) => err);
        await settle();
        // The process was suspended past the deadline and the native event was lost.
        h.native.clockMs += 30_000;
        answer(Response.json(new Payload('too-late')));

        expect(await outcome).toBeInstanceOf(ApiCallTimeoutError);
        expect(h.native.cancels).toEqual([h.native.starts[0].id]);
    });
});

describe('deadline races, settled exactly once', () => {
    it('completion wins; a LATE native callback afterwards changes nothing', async () => {
        const deadlines = new ManualDeadlines();
        const transport = new ScriptedTransport();

        await expect(manualClient(transport, deadlines).read(new Payload())).resolves.toEqual(
            new Payload('from-transport'),
        );
        deadlines.scheduled[0].fire();

        expect(transport.sent[0].init.signal.aborted).toBe(false);
        expect(deadlines.scheduled[0].cancelCount).toBe(1);
    });

    it('timeout wins over the abort-induced transport rejection, and fires once', async () => {
        const deadlines = new ManualDeadlines();
        const transport = new ScriptedTransport();
        transport.respond = (init: HttpFetchInit) =>
            new Promise<Response>((_resolve: (r: Response) => void, reject: (e: Error) => void) => {
                init.signal.addEventListener('abort', () => reject(new Error('Aborted')));
            });

        const outcome = manualClient(transport, deadlines)
            .read(new Payload())
            .catch((err: unknown) => err);
        await settle();
        deadlines.scheduled[0].fire();
        deadlines.scheduled[0].fire();

        expect(await outcome).toBeInstanceOf(ApiCallTimeoutError);
        expect(deadlines.scheduled[0].cancelCount).toBe(1);
    });

    it('a scheduler that throws synchronously fails the call before anything is sent', async () => {
        const deadlines = new ManualDeadlines();
        const broken = new Error('native timer module unavailable');
        deadlines.failNextSchedule = broken;
        const transport = new ScriptedTransport();

        await expect(manualClient(transport, deadlines).read(new Payload())).rejects.toBe(broken);
        expect(transport.sent).toHaveLength(0);
    });

    it('a retry backs off on the injected scheduler, each attempt with its own fresh deadline', async () => {
        vi.useFakeTimers({
            toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
        });
        ClientRegistry.setStrategy(
            new RetryStrategy(1_000, 1, 500, 2, 500).run,
            CallScope.method(RuntimeApi, 'read'),
        );
        const deadlines = new ManualDeadlines();
        const transport = new ScriptedTransport();
        let attempt = 0;
        transport.respond = () => {
            attempt++;
            return attempt === 1
                ? Promise.reject(new TypeError('Network request failed'))
                : Promise.resolve(Response.json(new Payload('second-attempt')));
        };

        const pending = manualClient(transport, deadlines).read(new Payload());
        await settle();
        expect(delays(deadlines)).toEqual([1_000, 500]);
        expect(vi.getTimerCount()).toBe(0);
        deadlines.scheduled[1].fire();

        await expect(pending).resolves.toEqual(new Payload('second-attempt'));
        expect(delays(deadlines)).toEqual([1_000, 500, 1_000]);
        expect(deadlines.scheduled[0].cancelCount).toBe(1);
        expect(deadlines.scheduled[2].cancelCount).toBe(1);
        expect(transport.sent).toHaveLength(2);
        expect(transport.sent[0].init.signal).not.toBe(transport.sent[1].init.signal);
    });
});

/** The shell acknowledgement crosses a REAL JSON boundary; it has no class prototype in the page. */
function shellHost(): MobileWebViewHost {
    return JSON.parse(
        JSON.stringify(
            new MobileWebViewHost('expo-webview', 1, 'document-7', 'session-3', true, true, true),
        ),
    ) as MobileWebViewHost;
}

function webViewClient(transport: ScriptedTransport, deadlines: ManualDeadlines): RuntimeApi {
    return new ClientHttpBrowserFactory(
        new MutableContextStore(),
        undefined,
        HttpClientRuntime.mobileWebView(transport.fetch, deadlines, shellHost()),
    ).createRpcClient(RuntimeApi, config());
}

describe('#1463 negotiated native HTTP in an embedded website', () => {
    it.each(['iPhone Safari', 'Android Chrome'])(
        '%s retains standalone browser defaults',
        async (userAgent) => {
            vi.stubGlobal('navigator', { product: 'Gecko', userAgent });
            const client = new ClientHttpBrowserFactory(new MutableContextStore()).createRpcClient(
                RuntimeApi,
                config(),
            );
            await expect(client.read(new Payload())).resolves.toEqual(new Payload('from-global'));
        },
    );

    it('a marker on window alone requires explicit shell capabilities, even with an RN runtime', () => {
        vi.stubGlobal('window', { ReactNativeWebView: { postMessage: (): void => undefined } });
        const transport = new ScriptedTransport();
        expect(
            () =>
                new ClientHttpBrowserFactory(
                    new MutableContextStore(),
                    undefined,
                    HttpClientRuntime.reactNative(transport.fetch, new ManualDeadlines()),
                ),
        ).toThrow(MobileWebViewRuntimeConfigError);
        expect(globalFetch).not.toHaveBeenCalled();
        expect(transport.sent).toHaveLength(0);
    });

    it('also refuses a marker installed between factory and client construction', () => {
        const factory = new ClientHttpBrowserFactory(new MutableContextStore());
        vi.stubGlobal('window', { ReactNativeWebView: { postMessage: (): void => undefined } });
        expect(() => factory.createRpcClient(RuntimeApi, config())).toThrow(
            MobileWebViewRuntimeConfigError,
        );
        expect(globalFetch).not.toHaveBeenCalled();
    });

    it.each([
        ['nativeHttp', false],
        ['nativeDeadlines', false],
        ['nativeCancellation', false],
        ['protocolVersion', 2],
        ['documentId', ''],
        ['sessionId', ''],
        ['kind', 'browser'],
    ])('refuses missing/incompatible %s from a serialized shell before HTTP', (key, value) => {
        const host = shellHost();
        Reflect.set(host, key, value);
        const transport = new ScriptedTransport();
        expect(() =>
            HttpClientRuntime.mobileWebView(transport.fetch, new ManualDeadlines(), host),
        ).toThrow(MobileWebViewRuntimeConfigError);
        expect(() =>
            HttpClientRuntime.mobileWebView(transport.fetch, new ManualDeadlines(), host),
        ).toThrow(key === 'kind' ? 'host kind' : key);
        expect(transport.sent).toHaveLength(0);
        expect(globalFetch).not.toHaveBeenCalled();
    });

    it('refuses absent shell, fetch and deadlines from untyped callers with an actionable issue link', () => {
        expect(() =>
            HttpClientRuntime.mobileWebView(
                undefined as unknown as HttpFetch,
                undefined as unknown as ManualDeadlines,
                undefined as unknown as MobileWebViewHost,
            ),
        ).toThrow(/fetch, deadlines, shell host capabilities/);
        vi.stubGlobal('ReactNativeWebView', { postMessage: (): void => undefined });
        expect(() => new ClientHttpBrowserFactory(new MutableContextStore())).toThrow(
            MobileWebViewRuntimeConfigError.ISSUE_URL,
        );
    });

    it('a declared shell works without a marker and never sends through the page fetch', async () => {
        const transport = new ScriptedTransport();
        const client = webViewClient(transport, new ManualDeadlines());
        await expect(client.read(new Payload('through-shell'))).resolves.toEqual(
            new Payload('from-transport'),
        );
        expect(transport.sent[0].init.body).toBe(JSON.stringify(new Payload('through-shell')));
        expect(globalFetch).not.toHaveBeenCalled();
    });

    it('a configured marked WebView sends through its injected transport', async () => {
        vi.stubGlobal('window', { ReactNativeWebView: { postMessage: (): void => undefined } });
        const transport = new ScriptedTransport();
        await expect(
            webViewClient(transport, new ManualDeadlines()).read(new Payload()),
        ).resolves.toEqual(new Payload('from-transport'));
        expect(globalFetch).not.toHaveBeenCalled();
    });

    it('native deadlines abort a stalled WebView body with page timers frozen', async () => {
        vi.useFakeTimers();
        const deadlines = new ManualDeadlines();
        const transport = new ScriptedTransport();
        transport.respond = () => Promise.resolve(new Response(new ReadableStream<Uint8Array>()));
        const pending = webViewClient(transport, deadlines).read(new Payload());
        const failed = expect(pending).rejects.toBeInstanceOf(ApiCallTimeoutError);
        await settle();
        deadlines.scheduled[0].fire();
        await failed;
        expect(transport.sent[0].init.signal.aborted).toBe(true);
        expect(deadlines.scheduled[0].cancelCount).toBe(1);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('copies the negotiated identity so mutation of bootstrap data cannot retarget existing clients', () => {
        const host = shellHost();
        const runtime = HttpClientRuntime.mobileWebView(
            new ScriptedTransport().fetch,
            new ManualDeadlines(),
            host,
        );
        Reflect.set(host, 'sessionId', 'another-account');
        expect(runtime.host?.sessionId).toBe('session-3');
        expect(Object.isFrozen(runtime.host)).toBe(true);
    });
});
