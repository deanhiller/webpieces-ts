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
import { ResponseHeadersListener } from '../ResponseHeadersListener';

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

/** A recording ResponseHeadersListener — captures every call for assertion. */
class RecordingListener implements ResponseHeadersListener {
    readonly calls: Array<{ route: RouteMetadata; version: string | null }> = [];

    onResponseHeaders(route: RouteMetadata, headers: Headers): void {
        this.calls.push({ route, version: headers.get('x-myorg-server-version') });
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
 * factory and reads response headers off every RPC call. The driver is client↔server version
 * matching (the server stamps x-<org>-server-version). Optional + non-breaking: a factory built
 * without a listener behaves exactly as before.
 */
describe('BrowserProxyClient reports response headers to a registered listener', () => {
    it('with NO listener the client still works — the seam is a no-op', async () => {
        const fetched = stubFetch();
        const bareFactory = new ClientHttpBrowserFactory(new MutableContextStore());
        const client = bareFactory.createRpcClient(PublicApi, new ClientConfig('save-svc'));

        await client.save(new SaveRequest('q'));

        expect(fetched.url()).toBe('/public/save');
    });

    it('a 2xx response invokes the listener once with the right route + headers', async () => {
        stubFetchWithHeaders(200, { 'x-myorg-server-version': '1.2.3' });
        const listener = new RecordingListener();
        const withListener = new ClientHttpBrowserFactory(new MutableContextStore(), listener);
        const client = withListener.createRpcClient(PublicApi, new ClientConfig('save-svc'));

        await client.save(new SaveRequest('q'));

        expect(listener.calls).toHaveLength(1);
        expect(listener.calls[0].version).toBe('1.2.3');
        expect(listener.calls[0].route.methodName).toBe('save');
    });

    it('an error response ALSO invokes the listener — version headers arrive on errors too', async () => {
        stubFetchWithHeaders(503, { 'x-myorg-server-version': '9.9.9' });
        const listener = new RecordingListener();
        const withListener = new ClientHttpBrowserFactory(new MutableContextStore(), listener);
        const client = withListener.createRpcClient(PublicApi, new ClientConfig('save-svc'));

        // webpieces-disable no-unmanaged-exceptions -- the 503 rethrows after the seam fires; we only assert the seam
        await expect(client.save(new SaveRequest('q'))).rejects.toBeDefined();

        expect(listener.calls).toHaveLength(1);
        expect(listener.calls[0].version).toBe('9.9.9');
        expect(listener.calls[0].route.methodName).toBe('save');
    });
});
