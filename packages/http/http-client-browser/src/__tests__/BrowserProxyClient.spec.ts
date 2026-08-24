import 'reflect-metadata';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    ApiPath,
    AuthApiKey,
    AuthOidc,
    AuthSharedSecret,
    ClientRegistry,
    ContextKey,
    Endpoint,
    HeaderRegistry,
    HttpBadGatewayError,
    HttpBadRequestError,
    HttpError,
    HttpForbiddenError,
    HttpNotFoundError,
    HttpServiceUnavailableError,
    HttpUnauthorizedError,
    OfflineError,
    Public,
    Rpc,
} from '@webpieces/core-util';
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
    @Public()
    // webpieces-disable no-unmanaged-exceptions -- abstract contract stub, never executed
    save(_request: SaveRequest): Promise<void> {
        throw new Error('contract only');
    }
}

@Rpc()
@ApiPath('/secure')
abstract class OidcApi {
    @Endpoint('/internalOp', 'rpc')
    @AuthOidc()
    // webpieces-disable no-unmanaged-exceptions -- abstract contract stub, never executed
    internalOp(_request: SaveRequest): Promise<void> {
        throw new Error('contract only');
    }
}

@Rpc()
@ApiPath('/secret')
abstract class SharedSecretApi {
    @Endpoint('/internalOp', 'rpc')
    @AuthSharedSecret('INTERNAL_API_SECRET')
    // webpieces-disable no-unmanaged-exceptions -- abstract contract stub, never executed
    internalOp(_request: SaveRequest): Promise<void> {
        throw new Error('contract only');
    }
}

@Rpc()
@ApiPath('/management/v1')
abstract class ApiKeyApi {
    @Endpoint('/orders', 'rpc')
    @AuthApiKey('onetablet-partner', [{ in: 'header', name: 'x-api-key' }])
    // webpieces-disable no-unmanaged-exceptions -- abstract contract stub, never executed
    listOrders(_request: SaveRequest): Promise<void> {
        throw new Error('contract only');
    }
}

const TENANT = ContextKey.untrusted<string>('tenantId', 'x-tenant-id');

let factory: ClientHttpBrowserFactory;

beforeEach(() => {
    HeaderRegistry.configure([TENANT], /*platformHeaders*/ true);
    ClientRegistry.clear();
    factory = new ClientHttpBrowserFactory(new MutableContextStore());
});

afterEach(() => {
    ClientRegistry.clear();
    vi.unstubAllGlobals();
});

/** Capture the URL the client actually fetches, without a network. */
function stubFetch(): { url: () => string } {
    const fetchMock = vi.fn(() =>
        Promise.resolve(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })),
    );
    vi.stubGlobal('fetch', fetchMock);
    return { url: (): string => String(fetchMock.mock.calls[0]?.[0]) };
}

/** Stub fetch with a chosen status + response headers, so the inbound seam can be observed. */
function stubFetchWithHeaders(status: number, headers: Record<string, string>): void {
    const body = status < 400 ? '{}' : JSON.stringify({ code: 'ERR', message: 'boom' });
    const fetchMock = vi.fn(() =>
        Promise.resolve(new Response(body, { status, headers: { 'Content-Type': 'application/json', ...headers } })),
    );
    vi.stubGlobal('fetch', fetchMock);
}

/** Stub fetch with a webpieces ProtocolError body at the given status — the ordinary error path. */
function stubFetchProtocolError(status: number, message: string): void {
    const fetchMock = vi.fn(() =>
        Promise.resolve(
            new Response(JSON.stringify({ message }), {
                status,
                headers: { 'Content-Type': 'application/json' },
            }),
        ),
    );
    vi.stubGlobal('fetch', fetchMock);
}

/** Stub fetch so the call REJECTS at the network layer — offline, DNS failure, CORS preflight. */
function stubFetchNetworkReject(err: Error): void {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(err)));
}

/** Stub fetch with a body that is NOT JSON — an infra 502/504 serving an HTML error page. */
function stubFetchNonJsonBody(status: number): void {
    const fetchMock = vi.fn(() =>
        Promise.resolve(new Response(`<html><head><title>${status} from the load balancer</title></head></html>`, {
            status,
            headers: { 'Content-Type': 'text/html', 'x-myorg-server-version': '4.5.6' },
        })),
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
 * first call in production. `@AuthApiKey` is refused too, for the adjacent reason: the credential is a
 * CUSTOMER's key (which a browser must never carry) and the header carrying it is the app's ApiKeyHook's
 * choice, so no webpieces client knows what to send.
 */
describe('BrowserProxyClient rejects endpoints a browser cannot satisfy', () => {
    it('throws for an @AuthOidc contract', () => {
        expect(() => factory.createRpcClient(OidcApi, new ClientConfig('save-svc')))
            .toThrow(/@AuthOidc — a browser cannot hold service credentials/);
    });

    it('throws for an @AuthSharedSecret contract', () => {
        expect(() => factory.createRpcClient(SharedSecretApi, new ClientConfig('save-svc')))
            .toThrow(/@AuthSharedSecret — a browser cannot hold service credentials/);
    });

    it('throws for an @AuthApiKey contract, naming the regime and who may actually call it', () => {
        expect(() => factory.createRpcClient(ApiKeyApi, new ClientConfig('save-svc')))
            .toThrow(/@AuthApiKey\('onetablet-partner'\).*customer-held/s);
    });

    it('accepts a @Public contract and binds its routes', () => {
        const client = factory.createRpcClient(PublicApi, new ClientConfig('save-svc'));

        // The Proxy resolves the declared endpoint...
        expect(typeof client.save).toBe('function');
        // ...and rejects one the contract never declared.
        // webpieces-disable no-any-unknown -- deliberately probing an undeclared method
        expect(() => (client as any).notAnEndpoint).toThrow(/No route found for method 'notAnEndpoint'/);
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
    it('a NETWORK reject ends with status 0 and surfaces a typed OfflineError', async () => {
        const networkErr = new Error('Failed to fetch');
        stubFetchNetworkReject(networkErr);
        const listener = new RecordingListener();

        // The raw reject is now CLASSIFIED into a typed OfflineError before it rethrows, so an app
        // does one `instanceof OfflineError` check instead of matching browser message text.
        // webpieces-disable no-unmanaged-exceptions -- the classified reject rethrows after the seam fires
        await expect(clientWith(listener).save(new SaveRequest('q'))).rejects.toBeInstanceOf(OfflineError);

        const outcome = listener.onlyEnd();
        expect(outcome.ok).toBe(false);
        expect(outcome.status).toBe(0);
        expect(outcome.headers).toBeUndefined();
        expect(outcome.error).toBeInstanceOf(OfflineError);
        // The original reject stays reachable as `cause`, so no detail is lost.
        expect((outcome.error as OfflineError).cause).toBe(networkErr);
    });

    /**
     * An infra 502/504 (load balancer, proxy) serves HTML, so parsing it as our ProtocolError
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
    it('a 502 HTML page rejects with HttpBadGatewayError, not SyntaxError', async () => {
        stubFetchNonJsonBody(502);

        // webpieces-disable no-unmanaged-exceptions -- asserting the type of the rejection IS the test
        const error = await client().save(new SaveRequest('q')).catch((err: unknown) => err);

        expect(error).toBeInstanceOf(HttpBadGatewayError);
        expect(error).not.toBeInstanceOf(SyntaxError);
        expect((error as HttpBadGatewayError).code).toBe(502);
        // Names the call and what actually arrived, so the log line says which endpoint and why.
        expect((error as Error).message).toContain('PublicApi.save');
        expect((error as Error).message).toContain('text/html');
    });

    it('a 503 cold start rejects with HttpServiceUnavailableError — the "retry, it is waking" signal', async () => {
        stubFetchNonJsonBody(503);

        // webpieces-disable no-unmanaged-exceptions -- asserting the type of the rejection IS the test
        const error = await client().save(new SaveRequest('q')).catch((err: unknown) => err);

        expect(error).toBeInstanceOf(HttpServiceUnavailableError);
        expect((error as HttpServiceUnavailableError).code).toBe(503);
    });

    it('a 2xx that is not JSON reports WHAT arrived instead of "Unexpected token \'<\'"', async () => {
        stubFetchNonJsonBody(200);

        // webpieces-disable no-unmanaged-exceptions -- asserting the type of the rejection IS the test
        const error = await client().save(new SaveRequest('q')).catch((err: unknown) => err);

        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain('PublicApi.save');
        expect((error as Error).message).toContain('text/html');
        expect((error as Error).message).not.toContain('Unexpected token');
    });
});

/**
 * THE ASYMMETRY, browser half. `ProxyClient.adaptDownstreamFailure` is the seam where the two
 * environments part company, and this is the side that must NOT change:
 *
 *   In a browser the client IS the end user's agent, and the "downstream" is the app's own backend.
 *   A 404 really does mean "that thing does not exist", a 401 really does mean "sign in again", a 403
 *   really does mean "you may not". Each is a real answer to the user, and rewriting any of them to a
 *   500 would delete the only signal the UI has to act on.
 *
 * The server twin does the OPPOSITE for the same reason — there the downstream is a dependency, and
 * its 4xx describes the caller's own broken request. See NodeProxyClient's spec.
 */
describe('BrowserProxyClient rethrows a downstream 4xx EXACTLY as translated', () => {
    it('404 stays HttpNotFoundError — the resource genuinely does not exist for this user', async () => {
        stubFetchProtocolError(404, 'no such order');

        // webpieces-disable no-unmanaged-exceptions -- asserting the type of the rejection IS the test
        const error = await client().save(new SaveRequest('q')).catch((err: unknown) => err);

        expect(error).toBeInstanceOf(HttpNotFoundError);
        expect((error as HttpError).code).toBe(404);
        expect((error as Error).message).toBe('no such order');
    });

    it('400 / 401 / 403 each stay their own type, with their own status and message', async () => {
        stubFetchProtocolError(400, 'email is required');
        // webpieces-disable no-unmanaged-exceptions -- asserting the type of the rejection IS the test
        const badRequest = await client().save(new SaveRequest('q')).catch((err: unknown) => err);
        expect(badRequest).toBeInstanceOf(HttpBadRequestError);
        expect((badRequest as HttpError).code).toBe(400);

        stubFetchProtocolError(401, 'token expired');
        // webpieces-disable no-unmanaged-exceptions -- asserting the type of the rejection IS the test
        const unauthorized = await client().save(new SaveRequest('q')).catch((err: unknown) => err);
        expect(unauthorized).toBeInstanceOf(HttpUnauthorizedError);
        expect((unauthorized as HttpError).code).toBe(401);

        stubFetchProtocolError(403, 'not your org');
        // webpieces-disable no-unmanaged-exceptions -- asserting the type of the rejection IS the test
        const forbidden = await client().save(new SaveRequest('q')).catch((err: unknown) => err);
        expect(forbidden).toBeInstanceOf(HttpForbiddenError);
        expect((forbidden as HttpError).code).toBe(403);
    });

    it('an HTML 404 from misrouted infra also arrives unchanged — a browser has no caller to protect', async () => {
        stubFetchNonJsonBody(404);

        // webpieces-disable no-unmanaged-exceptions -- asserting the type of the rejection IS the test
        const error = await client().save(new SaveRequest('q')).catch((err: unknown) => err);

        expect(error).toBeInstanceOf(HttpNotFoundError);
        expect((error as Error).message).toContain('PublicApi.save');
        expect((error as Error).message).toContain('text/html');
    });

    it('the lifecycle listener sees the SAME error the caller does', async () => {
        stubFetchProtocolError(404, 'no such order');
        const listener = new RecordingListener();

        // webpieces-disable no-unmanaged-exceptions -- asserting the type of the rejection IS the test
        const error = await clientWith(listener).save(new SaveRequest('q')).catch((err: unknown) => err);

        expect(listener.onlyEnd().error).toBe(error);
    });
});
