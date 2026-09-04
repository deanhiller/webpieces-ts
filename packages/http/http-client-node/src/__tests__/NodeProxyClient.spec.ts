import 'reflect-metadata';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    ApiPath,
    ClientRegistry,
    DestinationTrust,
    Endpoint,
    ErrorTranslators,
    HttpResponseDto,
    HttpBadGatewayError,
    HttpError,
    HttpInternalServerError,
    HttpNotFoundError,
    HttpServiceUnavailableError,
    HttpVendorError,
    ProtocolError,
    Public,
    Rpc,
    TestCaseRecorder,
} from '@webpieces/core-util';
import type { RequestContextHeaders } from '@webpieces/core-context';
import { RequestContext } from '@webpieces/core-context';
import type { GcpOidc } from '@webpieces/gcp-identity';
import { buildClientProxy } from '@webpieces/http-client-core';
import { AddressResolver } from '../AddressResolver';
import { ClientConfig } from '../ClientConfig';
import { NodeProxyClient } from '../NodeProxyClient';

class FetchStoresRequest {
    constructor(public readonly limit: number) {}
}

/** The contract from the real incident: public-api → pg-dataaccess over an RPC client. */
@Rpc()
@ApiPath('/db-stores')
abstract class DbStoresApi {
    @Endpoint('/fetch-stores', 'rpc')
    @Public()
    // webpieces-disable no-unmanaged-exceptions -- abstract contract stub, never executed
    fetchStores(_request: FetchStoresRequest): Promise<void> {
        throw new Error('contract only');
    }
}

/**
 * RequestContextHeaders stand-in. NodeProxyClient asks it for exactly two things on this path —
 * outbound headers and a (absent) test recorder — and neither is what these tests are about.
 */
class StubHeaders {
    buildOutboundHeaders(_destination: DestinationTrust): Map<string, string> {
        return new Map<string, string>();
    }

    findRecorder(): TestCaseRecorder | undefined {
        return undefined;
    }
}

/**
 * Proves, by exploding, that the SSRF guard never resolves anything on the deployed path: nothing in
 * this spec re-points a request, so the guard steps aside before any name reaches a resolver.
 */
class ThrowingAddressResolver extends AddressResolver {
    override resolve(hostname: string): Promise<string[]> {
        throw new Error(
            `the SSRF guard must not resolve ${hostname} for a ClientRegistry-resolved url`,
        );
    }
}

/** GcpOidc stand-in. Every contract here is @Public, so nothing ever mints a token. */
class StubOidc {
    mintIdToken(_audience: string): Promise<string> {
        return Promise.resolve('never-used');
    }
}

/** A real NodeProxyClient bound to the contract, behind the same Proxy a factory would build. */
function client(): DbStoresApi {
    const proxyClient = new NodeProxyClient(
        // webpieces-disable no-any-unknown -- test double: only buildOutboundHeaders/findRecorder are reached
        new StubHeaders() as unknown as RequestContextHeaders,
        // webpieces-disable no-any-unknown -- test double: no @AuthOidc endpoint exists in this spec
        new StubOidc() as unknown as GcpOidc,
        // Never consulted: every url here comes from ClientRegistry, so the SSRF guard steps aside.
        new ThrowingAddressResolver(),
    );
    proxyClient.init(DbStoresApi, new ClientConfig('pg-dataaccess'), []);
    return buildClientProxy(DbStoresApi, proxyClient);
}

/** Stub fetch with a webpieces ProtocolError body — a real downstream webpieces server answering. */
function stubProtocolError(status: number, message: string): void {
    vi.stubGlobal(
        'fetch',
        vi.fn(() =>
            Promise.resolve(
                new Response(JSON.stringify({ message }), {
                    status,
                    headers: { 'Content-Type': 'application/json' },
                }),
            ),
        ),
    );
}

/**
 * The EXACT prod shape: Express's own default 404 page, because the dependency's routes were not
 * deployed yet. `content-type: text/html`, body `<pre>Cannot POST /db-stores/fetch-stores</pre>`.
 */
function stubExpressHtml404(): void {
    vi.stubGlobal(
        'fetch',
        vi.fn(() =>
            Promise.resolve(
                new Response('<pre>Cannot POST /db-stores/fetch-stores</pre>', {
                    status: 404,
                    headers: { 'Content-Type': 'text/html; charset=utf-8' },
                }),
            ),
        ),
    );
}

/**
 * Call the client and hand back whatever it rejected with, inside a real RequestContext scope —
 * NodeProxyClient builds its own RequestContext-backed ApiCallContext, so a live scope is all the
 * setup there is. (This replaced a hand-rolled NoopApiCallContext + a holder install.)
 */
async function callAndCatch(): Promise<unknown> {
    // webpieces-disable no-unmanaged-exceptions -- asserting the type of the rejection IS the test
    return RequestContext.run(() =>
        client()
            .fetchStores(new FetchStoresRequest(51))
            .catch((err: unknown) => err),
    );
}

beforeEach(() => {
    ClientRegistry.clear();
    ClientRegistry.addUrlMapping('pg-dataaccess', 'https://pg-dataaccess.example.com');
});

afterEach(() => {
    ClientRegistry.clear();
    vi.unstubAllGlobals();
});

/**
 * THE ASYMMETRY, server half — the whole point of this suite.
 *
 *   A status received from a downstream dependency describes OUR request to it. It is never the
 *   status we return to OUR caller. The server that answered 404 is correct; the server that asked
 *   for a route that does not exist is broken, and must say so as a 500.
 *
 * The prod incident this fixes: a partner-facing Management API called a dependency that had not been
 * promoted yet. Express served its default HTML 404, the client turned it into `HttpNotFoundError`,
 * and the partner-facing response carried no `stores` key at all — so `jq '.stores | length'` read 0
 * for an org with six live storefronts. The failure impersonated valid data instead of paging the one
 * server that actually had the bug.
 */
describe("NodeProxyClient turns a downstream 4xx into THIS server's own 500", () => {
    it('a 404 from a dependency is HttpInternalServerError, NOT HttpNotFoundError', async () => {
        stubProtocolError(404, 'no route');

        const error = await callAndCatch();

        expect(error).toBeInstanceOf(HttpInternalServerError);
        expect(error).not.toBeInstanceOf(HttpNotFoundError);
        expect((error as HttpError).code).toBe(500);
    });

    it('THE INCIDENT: an HTML 404 from an undeployed dependency, with the diagnostic kept as the cause', async () => {
        stubExpressHtml404();

        const error = await callAndCatch();

        expect(error).toBeInstanceOf(HttpInternalServerError);
        expect((error as HttpError).code).toBe(500);

        // The 500's own message names the call and the status it is answering FOR.
        expect((error as Error).message).toContain('DbStoresApi.fetchStores');
        expect((error as Error).message).toContain('404');

        // The original client-side diagnostic — the text that made this findable in one read — is
        // reachable as the cause, and quoted in the message too.
        const cause = (error as HttpError).httpCause!;
        expect(cause).toBeInstanceOf(HttpNotFoundError);
        expect(cause.message).toContain('DbStoresApi.fetchStores');
        expect(cause.message).toContain('text/html');
        expect(cause.message).toContain('did not come from the webpieces server');
        expect(cause.message).toContain('Cannot POST /db-stores/fetch-stores');
        expect((error as Error).message).toContain('Cannot POST /db-stores/fetch-stores');
    });

    it('400 / 401 / 403 / 404 are ALL caller-side defects on this hop, so all four become 500', async () => {
        for (const status of [400, 401, 403, 404]) {
            stubProtocolError(status, `downstream said ${status}`);

            const error = await callAndCatch();

            expect((error as HttpError).code).toBe(500);
            expect(error).toBeInstanceOf(HttpInternalServerError);
            expect((error as Error).message).toContain(`HTTP ${status}`);
            expect((error as HttpError).httpCause!.message).toBe(`downstream said ${status}`);
        }
    });

    /**
     * INTENDED, not a false positive. A dependency that 404s because the ROW is missing is
     * indistinguishable on the wire from one that 404s because the ROUTE is missing, and the caller
     * cannot tell them apart. An RPC contract that needs "absent" as an ANSWER models it in the
     * response DTO (a nullable field, an empty list), not as an HTTP status.
     */
    it('a LEGITIMATE resource 404 from a dependency still becomes a 500 — deliberately', async () => {
        stubProtocolError(404, 'store 1234 does not exist');

        const error = await callAndCatch();

        expect(error).toBeInstanceOf(HttpInternalServerError);
        expect((error as HttpError).httpCause!.message).toBe('store 1234 does not exist');
    });
});

/**
 * The scope line. 5xx already means "the dependency is unavailable" — honest and useful outward —
 * and 500 is already a 500. 266 (HttpUserError, a 2xx code carrying user validation) and 598
 * (HttpVendorError) are not statuses about our request at all. None of them is rewritten.
 */
describe('NodeProxyClient passes everything that is not a 4xx through unchanged', () => {
    it('502 / 503 keep their type — "the dependency is waking / unavailable" is the right signal', async () => {
        stubProtocolError(502, 'upstream refused');
        expect(await callAndCatch()).toBeInstanceOf(HttpBadGatewayError);

        stubProtocolError(503, 'cold start');
        expect(await callAndCatch()).toBeInstanceOf(HttpServiceUnavailableError);
    });

    it('a downstream 500 stays a 500 (and is NOT double-wrapped)', async () => {
        stubProtocolError(500, 'dependency blew up');

        const error = await callAndCatch();

        expect(error).toBeInstanceOf(HttpInternalServerError);
        expect((error as Error).message).toBe('dependency blew up');
        expect((error as HttpError).httpCause).toBeUndefined();
    });

    it('598 HttpVendorError is untouched — it is not a status about OUR request', async () => {
        stubProtocolError(598, 'vendor is rate limiting us');

        const error = await callAndCatch();

        expect(error).toBeInstanceOf(HttpVendorError);
        expect((error as Error).message).toBe('vendor is rate limiting us');
    });

    /**
     * 266 (HttpUserError) cannot reach this seam AT ALL, and that is worth pinning: it is a 2xx, so
     * `response.ok` is true and the body goes down the SUCCESS path. The wrap could never have
     * touched it even if it wanted to.
     */
    it('266 never reaches the failure seam — it is a 2xx, so it is read as a success body', async () => {
        stubProtocolError(266, 'that email is already taken');

        const result = await callAndCatch();

        expect(result).not.toBeInstanceOf(Error);
        expect(result).toEqual({ message: 'that email is already taken' });
    });
});

/**
 * THE OPT-OUT, and there is only one: a `ClientRegistry` error translation registered at startup.
 * A thin proxy or gateway that genuinely wants to relay a downstream status as its own says so in one
 * greppable line, and that decision wins here. There is deliberately NO ClientConfig flag and NO
 * webpieces.config.json key — a flag would make the dangerous choice invisible in the code that
 * suffers from it, whereas `grep -rn setErrorTranslators` lists every app that opted out.
 */
describe('an app-registered translation WINS over the node 4xx-to-500 wrap', () => {
    it('a registered 404 translation relays the downstream status as the app chose', async () => {
        const relay: ErrorTranslators = {
            toWire: () => undefined,
            fromWire: (response: HttpResponseDto) =>
                response.status.code === 404
                    ? new HttpNotFoundError(
                          (response.body as ProtocolError).message ?? 'relayed 404',
                      )
                    : undefined,
        };
        ClientRegistry.setErrorTranslators(relay);
        stubProtocolError(404, 'no such store');

        const error = await callAndCatch();

        expect(error).toBeInstanceOf(HttpNotFoundError);
        expect(error).not.toBeInstanceOf(HttpInternalServerError);
        expect((error as Error).message).toBe('no such store');
    });

    it('a status the registration does NOT claim still gets wrapped', async () => {
        const relay: ErrorTranslators = {
            toWire: () => undefined,
            fromWire: (response: HttpResponseDto) =>
                response.status.code === 404
                    ? new HttpNotFoundError(
                          (response.body as ProtocolError).message ?? 'relayed 404',
                      )
                    : undefined,
        };
        ClientRegistry.setErrorTranslators(relay);
        stubProtocolError(403, 'our service account is not on the allow-list');

        const error = await callAndCatch();

        expect(error).toBeInstanceOf(HttpInternalServerError);
        expect((error as HttpError).httpCause!.message).toBe(
            'our service account is not on the allow-list',
        );
    });
});

/**
 * THE REGRESSION, http half. The same defect the cloudtasks spec pins: a non-webpieces node host that
 * never ran `setupRuntime` used to get `ApiCallContext is not installed` on the first real call.
 *
 * Nothing in THIS FILE installs an ApiCallContext — NodeProxyClient builds its own
 * RequestContextApiCallContext — so an open RequestContext is the whole of the per-call setup.
 *
 * A node client still needs its BASE URL resolvable: ClientRegistry throws on node with no mapping and
 * no deriver, which is why the beforeEach above registers one. That is a separate, LOUD, startup-time
 * failure with its own message, not this one.
 */
describe('NodeProxyClient calls from a host that never ran setupRuntime', () => {
    it('does not throw "ApiCallContext is not installed" — the call reaches fetch and returns', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(() =>
                Promise.resolve(
                    new Response('{"ok":true}', {
                        status: 200,
                        headers: { 'Content-Type': 'application/json' },
                    }),
                ),
            ),
        );

        const result = await RequestContext.run(() =>
            client().fetchStores(new FetchStoresRequest(51)),
        );

        expect(result).toEqual({ ok: true });
    });
});
