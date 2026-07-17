import 'reflect-metadata';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    ApiPath,
    AuthOidc,
    AuthSharedSecret,
    ClientRegistry,
    ContextKey,
    Endpoint,
    HeaderRegistry,
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
    @Endpoint('/save')
    @Public()
    // webpieces-disable no-unmanaged-exceptions -- abstract contract stub, never executed
    save(_request: SaveRequest): Promise<void> {
        throw new Error('contract only');
    }
}

@Rpc()
@ApiPath('/secure')
abstract class OidcApi {
    @Endpoint('/internalOp')
    @AuthOidc()
    // webpieces-disable no-unmanaged-exceptions -- abstract contract stub, never executed
    internalOp(_request: SaveRequest): Promise<void> {
        throw new Error('contract only');
    }
}

@Rpc()
@ApiPath('/secret')
abstract class SharedSecretApi {
    @Endpoint('/internalOp')
    @AuthSharedSecret('INTERNAL_API_SECRET')
    // webpieces-disable no-unmanaged-exceptions -- abstract contract stub, never executed
    internalOp(_request: SaveRequest): Promise<void> {
        throw new Error('contract only');
    }
}

const TENANT = new ContextKey('tenantId', 'x-tenant-id');

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

/** Stub fetch so the call REJECTS at the network layer — offline, DNS failure, CORS preflight. */
function stubFetchNetworkReject(err: Error): void {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(err)));
}

/** Stub fetch with a body that is NOT JSON — an infra 502/504 serving an HTML error page. */
function stubFetchNonJsonBody(status: number): void {
    const fetchMock = vi.fn(() =>
        Promise.resolve(new Response('<html>502 Bad Gateway</html>', {
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
 * first call in production.
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
    it('a NETWORK reject ends with status 0 and no headers — no Response ever existed', async () => {
        const networkErr = new Error('Failed to fetch');
        stubFetchNetworkReject(networkErr);
        const listener = new RecordingListener();

        // webpieces-disable no-unmanaged-exceptions -- the reject rethrows UNTOUCHED after the seam fires
        await expect(clientWith(listener).save(new SaveRequest('q'))).rejects.toThrow('Failed to fetch');

        const outcome = listener.onlyEnd();
        expect(outcome.ok).toBe(false);
        expect(outcome.status).toBe(0);
        expect(outcome.headers).toBeUndefined();
        expect(outcome.error).toBe(networkErr);
    });

    /**
     * An infra 502/504 (load balancer, proxy) serves HTML, so parsing it as our ProtocolError
     * throws — and that is EXACTLY the 5xx case this seam exists to catch.
     */
    it('a non-JSON error body STILL ends — an infra 502 serving HTML must not leak the bar', async () => {
        stubFetchNonJsonBody(502);
        const listener = new RecordingListener();

        // webpieces-disable no-unmanaged-exceptions -- the parse failure rethrows after the seam fires
        await expect(clientWith(listener).save(new SaveRequest('q'))).rejects.toBeDefined();

        const outcome = listener.onlyEnd();
        expect(outcome.ok).toBe(false);
        expect(outcome.status).toBe(502);
        expect(outcome.error).toBeDefined();
        expect(outcome.headers?.get('x-myorg-server-version')).toBe('4.5.6');
    });
});
