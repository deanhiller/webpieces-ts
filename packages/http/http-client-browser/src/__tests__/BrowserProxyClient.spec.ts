import 'reflect-metadata';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    ApiPath,
    WpAuthApiKey,
    WpAuthOidc,
    WpAuthSharedSecret,
    ClientRegistry,
    ContextKey,
    Endpoint,
    HeaderRegistry,
    ApiDependencyError,
    ApiEndUserError,
    ApiImplementationError,
    LogManager,
    ApiConnectionError,
    WpAuthPublic,
    Rpc,
    WebpiecesCoreHeaders,
} from '@webpieces/core-util';
import type { ApiCallInfo, Logger, LoggerFactory } from '@webpieces/core-util';
import { BrowserApiCallContext } from '../BrowserApiCallContext';
import { RouteMetadata } from '@webpieces/core-util';
import { ClientConfig } from '../ClientConfig';
import { ClientHttpBrowserFactory } from '../ClientHttpBrowserFactory';
import { MutableContextStore } from '../MutableContextStore';
import { RequestOutcome } from '@webpieces/http-client-core';
import { RequestLifecycleListener } from '../RequestLifecycleListener';

class SaveRequest {
    constructor(public readonly query: string) {}
}

@Rpc()
@ApiPath('/public')
abstract class PublicApi {
    @Endpoint('/save', 'rpc')
    @WpAuthPublic('Anonymous access is intentionally required')
    // webpieces-disable no-unmanaged-exceptions -- abstract contract stub, never executed
    save(_request: SaveRequest): Promise<void> {
        throw new Error('contract only');
    }
}

@Rpc()
@ApiPath('/secure')
abstract class OidcApi {
    @Endpoint('/internalOp', 'rpc')
    @WpAuthOidc()
    // webpieces-disable no-unmanaged-exceptions -- abstract contract stub, never executed
    internalOp(_request: SaveRequest): Promise<void> {
        throw new Error('contract only');
    }
}

@Rpc()
@ApiPath('/secret')
abstract class SharedSecretApi {
    @Endpoint('/internalOp', 'rpc')
    @WpAuthSharedSecret('INTERNAL_API_SECRET')
    // webpieces-disable no-unmanaged-exceptions -- abstract contract stub, never executed
    internalOp(_request: SaveRequest): Promise<void> {
        throw new Error('contract only');
    }
}

@Rpc()
@ApiPath('/management/v1')
abstract class ApiKeyApi {
    @Endpoint('/orders', 'rpc')
    @WpAuthApiKey('onetablet-partner', [{ in: 'header', name: 'x-api-key' }])
    // webpieces-disable no-unmanaged-exceptions -- abstract contract stub, never executed
    listOrders(_request: SaveRequest): Promise<void> {
        throw new Error('contract only');
    }
}

const TENANT = ContextKey.untrusted<string>('tenantId', 'x-tenant-id');

let factory: ClientHttpBrowserFactory;

beforeEach(() => {
    HeaderRegistry.configure([TENANT], /*platformHeaders*/ true);
    ClientRegistry.resetForTests();
    factory = new ClientHttpBrowserFactory(new MutableContextStore());
});

afterEach(() => {
    ClientRegistry.resetForTests();
    vi.unstubAllGlobals();
});

/** Capture the URL the client actually fetches, without a network. */
function stubFetch(): { url: () => string } {
    const fetchMock = vi.fn(() =>
        Promise.resolve(
            new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
        ),
    );
    vi.stubGlobal('fetch', fetchMock);
    return { url: (): string => String(fetchMock.mock.calls[0]?.[0]) };
}

/** Stub fetch with a chosen status + response headers, so the inbound seam can be observed. */
function stubFetchWithHeaders(status: number, headers: Record<string, string>): void {
    const body = status < 400 ? '{}' : JSON.stringify({ code: 'ERR', message: 'boom' });
    const fetchMock = vi.fn(() =>
        Promise.resolve(
            new Response(body, {
                status,
                headers: { 'Content-Type': 'application/json', ...headers },
            }),
        ),
    );
    vi.stubGlobal('fetch', fetchMock);
}

/** Stub fetch with a webpieces ApiErrorPayload body at the given status — the ordinary error path. */
function stubFetchApiErrorPayload(status: number, message: string, kindOverride?: string): void {
    const kind =
        kindOverride ??
        (status === 400
            ? 'bad-request'
            : status === 401
              ? 'unauthorized'
              : status === 403
                ? 'forbidden'
                : status === 404
                  ? 'not-found'
                  : 'implementation');
    const fetchMock = vi.fn(() =>
        Promise.resolve(
            new Response(JSON.stringify({ kind, message }), {
                status,
                headers: { 'Content-Type': 'application/json' },
            }),
        ),
    );
    vi.stubGlobal('fetch', fetchMock);
}

/** Stub fetch so the call REJECTS at the network layer — offline, DNS failure, CORS preflight. */
function stubFetchNetworkReject(err: Error): void {
    vi.stubGlobal(
        'fetch',
        vi.fn(() => Promise.reject(err)),
    );
}

/** Stub fetch with a body that is NOT JSON — an infra 502/504 serving an HTML error page. */
function stubFetchNonJsonBody(status: number): void {
    const fetchMock = vi.fn(() =>
        Promise.resolve(
            new Response(
                `<html><head><title>${status} from the load balancer</title></head></html>`,
                {
                    status,
                    headers: { 'Content-Type': 'text/html', 'x-myorg-server-version': '4.5.6' },
                },
            ),
        ),
    );
    vi.stubGlobal('fetch', fetchMock);
}

/** One recorded lifecycle callback, in the order the client fired it. */
class RecordedCall {
    constructor(
        public readonly kind: 'start' | 'end',
        public readonly route: RouteMetadata,
        public readonly outcome?: RequestOutcome,
    ) {}
}

/** The ordinary client: no lifecycle listener, just the caller's view of a call. */
function client(): PublicApi {
    return factory.createRpcClient(PublicApi, new ClientConfig('save-svc'));
}

/** Build a client whose calls report their lifecycle to `listener`. */
function clientWith(listener: RecordingListener): PublicApi {
    const withListener = new ClientHttpBrowserFactory(new MutableContextStore(), listener);
    return withListener.createRpcClient(PublicApi, new ClientConfig('save-svc'));
}

/** A recording RequestLifecycleListener — captures every callback, in order, for assertion. */
class RecordingListener implements RequestLifecycleListener {
    readonly calls: RecordedCall[] = [];

    onRequestStart(route: RouteMetadata): void {
        this.calls.push(new RecordedCall('start', route));
    }

    onRequestEnd(route: RouteMetadata, outcome: RequestOutcome): void {
        this.calls.push(new RecordedCall('end', route, outcome));
    }

    /** The single end callback — asserts the start/end pairing held before returning it. */
    onlyEnd(): RequestOutcome {
        expect(this.calls.map((call: RecordedCall) => call.kind)).toEqual(['start', 'end']);
        return this.calls[1].outcome!;
    }
}

/**
 * A browser app almost always calls the backend that SERVED it, so an unregistered svcName must
 * resolve to a relative URL (= same origin), never throw. It used to throw: a forgotten registration
 * killed sign-in with the request never leaving the page — the server logged nothing at all.
 */
describe('BrowserProxyClient resolves a base URL without ever throwing', () => {
    it('an UNREGISTERED svcName yields a RELATIVE url (same origin)', async () => {
        const fetched = stubFetch();
        const client = factory.createRpcClient(PublicApi, new ClientConfig('never-registered'));

        await client.save(new SaveRequest('q'));

        expect(fetched.url()).toBe('/public/save');
    });

    it('a registered mapping still WINS — the Angular dev server on :4201 reaching :8201', async () => {
        const fetched = stubFetch();
        ClientRegistry.addMapping('save-svc', 8201);
        const client = factory.createRpcClient(PublicApi, new ClientConfig('save-svc'));

        await client.save(new SaveRequest('q'));

        expect(fetched.url()).toBe('http://localhost:8201/public/save');
    });

    it('an installed deriver is honored in the browser too', async () => {
        const fetched = stubFetch();
        ClientRegistry.setDeriver((svc: string) => Promise.resolve(`https://${svc}.example.com`));
        const client = factory.createRpcClient(PublicApi, new ClientConfig('save-svc'));

        await client.save(new SaveRequest('q'));

        expect(fetched.url()).toBe('https://save-svc.example.com/public/save');
    });
});

/**
 * A browser holds no service credentials: it cannot mint an OIDC token as a runtime service
 * account, and it must never ship a shared secret. Both are rejected at createRpcClient(), not on the
 * first call in production. `@WpAuthApiKey` is refused too, for the adjacent reason: the credential is a
 * CUSTOMER's key (which a browser must never carry) and the header carrying it is the app's ApiKeyHook's
 * choice, so no webpieces client knows what to send.
 */
describe('BrowserProxyClient rejects endpoints a browser cannot satisfy', () => {
    it('throws for an @WpAuthOidc contract', () => {
        expect(() => factory.createRpcClient(OidcApi, new ClientConfig('save-svc'))).toThrow(
            /@WpAuthOidc — a browser cannot hold service credentials/,
        );
    });

    it('throws for an @WpAuthSharedSecret contract', () => {
        expect(() =>
            factory.createRpcClient(SharedSecretApi, new ClientConfig('save-svc')),
        ).toThrow(/@WpAuthSharedSecret — a browser cannot hold service credentials/);
    });

    it('throws for an @WpAuthApiKey contract, naming the regime and who may actually call it', () => {
        expect(() => factory.createRpcClient(ApiKeyApi, new ClientConfig('save-svc'))).toThrow(
            /@WpAuthApiKey\('onetablet-partner'\).*customer-held/s,
        );
    });

    it('accepts a @WpAuthPublic contract and binds its routes', () => {
        const client = factory.createRpcClient(PublicApi, new ClientConfig('save-svc'));

        // The Proxy resolves the declared endpoint...
        expect(typeof client.save).toBe('function');
        // ...and rejects one the contract never declared.
        // webpieces-disable no-any-unknown -- deliberately probing an undeclared method
        expect(() => (client as any).notAnEndpoint).toThrow(
            /No route found for method 'notAnEndpoint'/,
        );
    });
});

/**
 * The inbound seam symmetric with outbound header propagation: an app registers ONE listener on the
 * factory and observes the whole lifecycle of every RPC call — start, then end-with-outcome (which
 * carries the response headers). The drivers are a single progress bar spanning N requests per user
 * action, and client↔server version matching (the server stamps x-<org>-server-version).
 *
 * The INVARIANT the progress bar rests on: every start is followed by EXACTLY ONE end, on every
 * path. A start with no end leaves the bar spinning forever.
 *
 * Optional + non-breaking: a factory built without a listener behaves exactly as before.
 */
describe('BrowserProxyClient reports the request lifecycle to a registered listener', () => {
    it('with NO listener the client still works — the seam is a no-op', async () => {
        const fetched = stubFetch();
        const bareFactory = new ClientHttpBrowserFactory(new MutableContextStore());
        const client = bareFactory.createRpcClient(PublicApi, new ClientConfig('save-svc'));

        await client.save(new SaveRequest('q'));

        expect(fetched.url()).toBe('/public/save');
    });

    it('a 2xx fires start THEN end, exactly once each, ok with the route + headers', async () => {
        stubFetchWithHeaders(200, { 'x-myorg-server-version': '1.2.3' });
        const listener = new RecordingListener();

        await clientWith(listener).save(new SaveRequest('q'));

        // Ordering is the point: the bar must go on before the call, off after it.
        expect(listener.calls.map((call: RecordedCall) => call.kind)).toEqual(['start', 'end']);
        expect(listener.calls[0].route.methodName).toBe('save');

        const outcome = listener.onlyEnd();
        expect(outcome.ok).toBe(true);
        expect(outcome.status).toBe(200);
        expect(outcome.error).toBeUndefined();
        // The old header-only use case, preserved: read the version stamp off outcome.headers.
        expect(outcome.headers?.get('x-myorg-server-version')).toBe('1.2.3');
    });

    it('an HTTP error ALSO ends — version headers + the translated error arrive on errors too', async () => {
        stubFetchWithHeaders(503, { 'x-myorg-server-version': '9.9.9' });
        const listener = new RecordingListener();

        // webpieces-disable no-unmanaged-exceptions -- the 503 rethrows after the seam fires; we only assert the seam
        await expect(clientWith(listener).save(new SaveRequest('q'))).rejects.toBeDefined();

        const outcome = listener.onlyEnd();
        expect(outcome.ok).toBe(false);
        expect(outcome.status).toBe(503);
        expect(outcome.error).toBeDefined();
        expect(outcome.headers?.get('x-myorg-server-version')).toBe('9.9.9');
    });
});

/**
 * The bar-leak guards. Both of these paths reach the END marker only because executeFetch brackets
 * its body reads: a start with no end leaves the app's progress bar spinning forever, and these are
 * precisely the failures (offline, a 5xx from infra) a user is most likely to actually hit.
 */
describe('BrowserProxyClient ends the lifecycle even when no usable body ever arrives', () => {
    it('a NETWORK reject ends with status 0 and surfaces a typed ApiConnectionError', async () => {
        const networkErr = new Error('Failed to fetch');
        stubFetchNetworkReject(networkErr);
        const listener = new RecordingListener();

        // The raw reject is now CLASSIFIED into a typed ApiConnectionError before it rethrows, so an app
        // does one `instanceof ApiConnectionError` check instead of matching browser message text.
        // webpieces-disable no-unmanaged-exceptions -- the classified reject rethrows after the seam fires
        await expect(clientWith(listener).save(new SaveRequest('q'))).rejects.toBeInstanceOf(
            ApiConnectionError,
        );

        const outcome = listener.onlyEnd();
        expect(outcome.ok).toBe(false);
        expect(outcome.status).toBe(0);
        expect(outcome.headers).toBeUndefined();
        expect(outcome.error).toBeInstanceOf(ApiConnectionError);
        // The original reject stays reachable as `cause`, so no detail is lost.
        expect((outcome.error as ApiConnectionError).cause).toBe(networkErr);
    });

    /**
     * An infra 502/504 (load balancer, proxy) serves HTML, so parsing it as our ApiErrorPayload
     * throws — and that is EXACTLY the 5xx case this seam exists to catch.
     */
    it('a non-JSON error body STILL ends — an infra 502 serving HTML must not leak the bar', async () => {
        stubFetchNonJsonBody(502);
        const listener = new RecordingListener();

        // webpieces-disable no-unmanaged-exceptions -- the typed gateway error rethrows after the seam fires
        await expect(clientWith(listener).save(new SaveRequest('q'))).rejects.toBeDefined();

        const outcome = listener.onlyEnd();
        expect(outcome.ok).toBe(false);
        expect(outcome.status).toBe(502);
        expect(outcome.error).toBeDefined();
        expect(outcome.headers?.get('x-myorg-server-version')).toBe('4.5.6');
    });
});

/**
 * END TO END, through the real proxy + fetch: the cold-start defect. A scale-to-zero backend answers
 * with the load balancer's HTML page, which the client used to JSON.parse regardless of
 * content-type — so a 502 reached the app as `SyntaxError: Unexpected token '<'`, the status gone,
 * and the app's global handler classified booting infrastructure as a "Client Bug".
 */
describe('BrowserProxyClient gives the caller a STATUS-typed error for an infra HTML body', () => {
    it('a 502 HTML page rejects with ApiDependencyError, not SyntaxError', async () => {
        stubFetchNonJsonBody(502);

        // webpieces-disable no-unmanaged-exceptions -- asserting the type of the rejection IS the test
        const error = await client()
            .save(new SaveRequest('q'))
            .catch((err: unknown) => err);

        expect(error).toBeInstanceOf(ApiDependencyError);
        expect(error).not.toBeInstanceOf(SyntaxError);
        expect(error).not.toHaveProperty('code');
        // Names the call and what actually arrived, so the log line says which endpoint and why.
        expect((error as Error).message).toContain('PublicApi.save');
        expect((error as Error).message).toContain('text/html');
    });

    it('a 503 cold start rejects with ApiDependencyError — the peer is the one that is broken', async () => {
        stubFetchNonJsonBody(503);

        // webpieces-disable no-unmanaged-exceptions -- asserting the type of the rejection IS the test
        const error = await client()
            .save(new SaveRequest('q'))
            .catch((err: unknown) => err);

        expect(error).toBeInstanceOf(ApiDependencyError);
        expect(error).not.toHaveProperty('code');
    });

    it('a 2xx that is not JSON reports WHAT arrived instead of "Unexpected token \'<\'"', async () => {
        stubFetchNonJsonBody(200);

        // webpieces-disable no-unmanaged-exceptions -- asserting the type of the rejection IS the test
        const error = await client()
            .save(new SaveRequest('q'))
            .catch((err: unknown) => err);

        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain('PublicApi.save');
        expect((error as Error).message).toContain('text/html');
        expect((error as Error).message).not.toContain('Unexpected token');
    });
});

/**
 * THE UNIFORM RULE, browser half — and the ASYMMETRY this spec used to assert is GONE (issue #968).
 *
 * It used to read: "in a browser the client IS the end user's agent, so a 404 really does mean that
 * thing does not exist". That reasoning was wrong, and the wrongness is worth keeping written down.
 * A webpieces client does not browse; it calls a typed endpoint it was generated against. If it
 * received a 404 it called a path that does not exist — which is the CLIENT's bug, not an answer to
 * show a user. The one genuinely user-facing outcome has its own channel and always did: 266 /
 * `ApiEndUserError`, whose message is the only one published verbatim.
 *
 * So node and browser now share ONE class and ONE rule (`WebpiecesDefaultErrorTranslator`), and
 * `ProxyClient.adaptDownstreamFailure` — the seam that existed only to hold the two apart — is
 * deleted. Read in a browser it says exactly what it should: `ApiImplementationError` means the
 * client has a bug, `ApiDependencyError` means the server does.
 *
 * An app that genuinely wants a status relayed as its own type says so, greppably, in its registered
 * translator's `fromWire`.
 */
describe('BrowserProxyClient applies the SAME received-status rule as node', () => {
    it('404 becomes ApiImplementationError — this client called a path that does not exist', async () => {
        stubFetchApiErrorPayload(404, 'no such order');

        // webpieces-disable no-unmanaged-exceptions -- asserting the type of the rejection IS the test
        const error = await client()
            .save(new SaveRequest('q'))
            .catch((err: unknown) => err);

        expect(error).toBeInstanceOf(ApiImplementationError);
        expect((error as Error).message).toContain('404');
    });

    it('400 / 401 / 403 are all caller-side defects on this hop, so all three are MY bug', async () => {
        for (const status of [400, 401, 403]) {
            stubFetchApiErrorPayload(status, 'nope');
            // webpieces-disable no-unmanaged-exceptions -- asserting the type of the rejection IS the test
            const error = await client()
                .save(new SaveRequest('q'))
                .catch((err: unknown) => err);
            expect(error, `HTTP ${status}`).toBeInstanceOf(ApiImplementationError);
        }
    });

    it('an HTML 404 from misrouted infra keeps the diagnostic text in the message', async () => {
        stubFetchNonJsonBody(404);

        // webpieces-disable no-unmanaged-exceptions -- asserting the type of the rejection IS the test
        const error = await client()
            .save(new SaveRequest('q'))
            .catch((err: unknown) => err);

        expect(error).toBeInstanceOf(ApiImplementationError);
        expect((error as Error).message).toContain('PublicApi.save');
        expect((error as Error).message).toContain('text/html');
    });

    it('266 is still the end user answer, with the message published verbatim', async () => {
        stubFetchApiErrorPayload(266, 'Those passwords do not match', 'end-user');

        // webpieces-disable no-unmanaged-exceptions -- asserting the type of the rejection IS the test
        const error = await client()
            .save(new SaveRequest('q'))
            .catch((err: unknown) => err);

        expect(error).toBeInstanceOf(ApiEndUserError);
        expect((error as Error).message).toBe('Those passwords do not match');
    });

    it('the lifecycle listener sees the SAME error the caller does', async () => {
        stubFetchApiErrorPayload(404, 'no such order');
        const listener = new RecordingListener();

        // webpieces-disable no-unmanaged-exceptions -- asserting the type of the rejection IS the test
        const error = await clientWith(listener)
            .save(new SaveRequest('q'))
            .catch((err: unknown) => err);

        expect(listener.onlyEnd().error).toBe(error);
    });
});

/**
 * THE BROWSER TAGGING CONTRACT, end to end and with no bootstrap.
 *
 * Each BrowserProxyClient constructs its OWN BrowserApiCallContext (nothing installs one process-wide
 * any more), yet a browser logger reads the tag back through the STATIC
 * `BrowserApiCallContext.snapshot()`. That only works because the store is `private static` — which is
 * why these two tests exist: make it per-instance and browser log lines silently stop carrying `api`.
 *
 * The span is SYNCHRONOUS by contract (set → log → remove, never held across an `await`), so the ONLY
 * moment the tag is observable is inside the logger's own emit. That is exactly where this reads it.
 */
class SnapshotOnEmitLoggerFactory implements LoggerFactory {
    /** The `api` tag as it stood DURING each `[API-*]` emit — undefined if nothing was stamped. */
    readonly seen: (ApiCallInfo | undefined)[] = [];

    getLogger(_name: string): Logger {
        const record = (message: string): void => {
            if (!message.includes('[API-')) {
                return;
            }
            const tag = BrowserApiCallContext.snapshot().get(
                WebpiecesCoreHeaders.API_CALL_INFO.name,
            );
            this.seen.push(tag as ApiCallInfo | undefined);
        };
        return { trace: record, debug: record, info: record, warn: record, error: record };
    }
}

describe('BrowserProxyClient stamps the api tag with no factory install and no bootstrap', () => {
    it('the tag is READABLE off the static snapshot during the emit, and CLEARED after the call', async () => {
        const capturing = new SnapshotOnEmitLoggerFactory();
        LogManager.setFactory(capturing);
        stubFetch();

        // No holder install anywhere: the client built its own BrowserApiCallContext.
        await client().save(new SaveRequest('q'));

        // req + resp lines, both carrying the client-side identity for this contract.
        expect(capturing.seen.length).toBe(2);
        expect(capturing.seen[0]?.method.side).toBe('client');
        expect(capturing.seen[0]?.method.apiClass).toBe('PublicApi');
        expect(capturing.seen[0]?.type).toBe('request');
        expect(capturing.seen[1]?.type).toBe('response');
        expect(capturing.seen[1]?.result).toBe('success');

        // set → log → remove is one synchronous span, so nothing survives the call.
        expect(
            BrowserApiCallContext.snapshot().get(WebpiecesCoreHeaders.API_CALL_INFO.name),
        ).toBeUndefined();
    });

    it('two independently built clients stamp into the SAME static slot the logger reads', async () => {
        const capturing = new SnapshotOnEmitLoggerFactory();
        LogManager.setFactory(capturing);
        stubFetch();

        const other = new ClientHttpBrowserFactory(new MutableContextStore()).createRpcClient(
            PublicApi,
            new ClientConfig('save-svc'),
        );
        await client().save(new SaveRequest('q'));
        await other.save(new SaveRequest('q'));

        // 4 lines from 2 different BrowserApiCallContext instances — none of them silently blank.
        expect(capturing.seen.length).toBe(4);
        expect(capturing.seen.every((tag) => tag !== undefined)).toBe(true);
    });
});

it('a real Fetch 266 response remains protocol-ok but throws the user message from a generated browser client', async () => {
    const response = new Response(
        JSON.stringify({
            kind: 'end-user',
            message: 'Passwords do not match',
            errorCode: 'PASSWORD_MISMATCH',
        }),
        { status: 266, headers: { 'content-type': 'application/json' } },
    );
    expect(response.ok).toBe(true);
    vi.stubGlobal(
        'fetch',
        vi.fn(async () => response),
    );
    await expect(client().save(new SaveRequest('password'))).rejects.toMatchObject({
        name: 'ApiEndUserError',
        message: 'Passwords do not match',
        errorCode: 'PASSWORD_MISMATCH',
    });
});
