import 'reflect-metadata';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    ApiPath,
    ClientRegistry,
    DestinationTrust,
    Endpoint,
    ErrorTranslator,
    HttpResponseDto,
    ApiDependencyError,
    ApiEndUserError,
    WebpiecesDefaultErrorTranslator,
    ApiImplementationError,
    ApiNotFoundError,
    ApiUnavailableError,
    ApiDependencyBackoffError,
    ApiErrorPayload,
    WpAuthPublic,
    Rpc,
    TestCaseRecorder,
    POST,
    READ,
    RPC,
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
    @Endpoint(POST, '/fetch-stores', READ, RPC)
    @WpAuthPublic('Anonymous access is intentionally required')
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

/** GcpOidc stand-in. Every contract here is @WpAuthPublic, so nothing ever mints a token. */
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
        // webpieces-disable no-any-unknown -- test double: no @WpAuthOidc endpoint exists in this spec
        new StubOidc() as unknown as GcpOidc,
        // Never consulted: every url here comes from ClientRegistry, so the SSRF guard steps aside.
        new ThrowingAddressResolver(),
    );
    proxyClient.init(DbStoresApi, new ClientConfig('pg-dataaccess'), []);
    return buildClientProxy(DbStoresApi, proxyClient);
}

/** Stub fetch with a webpieces ApiErrorPayload body — a real downstream webpieces server answering. */
function stubApiErrorPayload(status: number, message: string, kind = kindForStatus(status)): void {
    vi.stubGlobal(
        'fetch',
        vi.fn(() =>
            Promise.resolve(
                new Response(JSON.stringify({ kind, message }), {
                    status,
                    headers: { 'Content-Type': 'application/json' },
                }),
            ),
        ),
    );
}

// webpieces-disable no-function-outside-class -- compact wire-fixture discriminator for this spec
function kindForStatus(status: number): string {
    switch (status) {
        case 266:
            return 'end-user';
        case 400:
            return 'bad-request';
        case 401:
            return 'unauthorized';
        case 403:
            return 'forbidden';
        case 404:
            return 'not-found';
        case 408:
            return 'request-timeout';
        case 429:
            return 'rate-limited';
        case 500:
            return 'implementation';
        case 502:
            return 'dependency';
        case 503:
            return 'unavailable';
        case 504:
            return 'dependency-timeout';
        default:
            return '';
    }
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
    ClientRegistry.resetForTests();
    ClientRegistry.addUrlMapping('pg-dataaccess', 'https://pg-dataaccess.example.com');
});

afterEach(() => {
    ClientRegistry.resetForTests();
    vi.unstubAllGlobals();
});

/**
 * THE UNIFORM RULE, server half — the whole point of this suite, and since #968 the BROWSER applies
 * the identical rule (see `BrowserProxyClient.spec.ts`).
 *
 *   A status received from a downstream dependency describes OUR request to it. It is never the
 *   status we return to OUR caller. The server that answered 404 is correct; the server that asked
 *   for a route that does not exist is broken, and must say so as a 500.
 *
 * The prod incident this fixes: a partner-facing Management API called a dependency that had not been
 * promoted yet. Express served its default HTML 404, the client turned it into `ApiNotFoundError`,
 * and the partner-facing response carried no `stores` key at all — so `jq '.stores | length'` read 0
 * for an org with six live storefronts. The failure impersonated valid data instead of paging the one
 * server that actually had the bug.
 */
describe("NodeProxyClient turns a downstream 4xx into THIS server's own 500", () => {
    it('a 404 from a dependency is ApiImplementationError, NOT ApiNotFoundError', async () => {
        stubApiErrorPayload(404, 'no route');

        const error = await callAndCatch();

        expect(error).toBeInstanceOf(ApiImplementationError);
        expect(error).not.toBeInstanceOf(ApiNotFoundError);
        expect(error).not.toHaveProperty('code');
    });

    it('THE INCIDENT: an HTML 404 from an undeployed dependency, with the diagnostic in the message', async () => {
        stubExpressHtml404();

        const error = await callAndCatch();

        expect(error).toBeInstanceOf(ApiImplementationError);
        expect(error).not.toHaveProperty('code');

        // The 500's own message names the call and the status it is answering FOR, and quotes the
        // client-side diagnostic — the text that made this findable in one read.
        expect((error as Error).message).toContain('DbStoresApi.fetchStores');
        expect((error as Error).message).toContain('404');
        expect((error as Error).message).toContain('text/html');
        expect((error as Error).message).toContain('did not come from the webpieces server');
        expect((error as Error).message).toContain('Cannot POST /db-stores/fetch-stores');
    });

    it('400 / 401 / 403 / 404 are ALL caller-side defects on this hop, so all four become 500', async () => {
        for (const status of [400, 401, 403, 404]) {
            stubApiErrorPayload(status, `downstream said ${status}`);

            const error = await callAndCatch();

            expect(error).not.toHaveProperty('code');
            expect(error).toBeInstanceOf(ApiImplementationError);
            expect((error as Error).message).toContain(String(status));
            // The peer's DECODED error travels as the cause, so the original type is still readable.
            expect(((error as Error).cause as Error).message).toBe(`downstream said ${status}`);
        }
    });

    /**
     * INTENDED, not a false positive. A dependency that 404s because the ROW is missing is
     * indistinguishable on the wire from one that 404s because the ROUTE is missing, and the caller
     * cannot tell them apart. An RPC contract that needs "absent" as an ANSWER models it in the
     * response DTO (a nullable field, an empty list), not as an HTTP status.
     */
    it('a LEGITIMATE resource 404 from a dependency still becomes a 500 — deliberately', async () => {
        stubApiErrorPayload(404, 'store 1234 does not exist');

        const error = await callAndCatch();

        expect(error).toBeInstanceOf(ApiImplementationError);
        expect(((error as Error).cause as Error).message).toBe('store 1234 does not exist');
    });
});

/**
 * The other half of the uniform rule (#968): a 5xx says the PEER broke, so this hop reports an
 * `ApiDependencyError` and its own failure metrics stay clean. An `ApiDependencyError` that ALREADY
 * came back that way is rethrown untouched — the fault is attributed further downstream and
 * re-wrapping it once per hop would bury the original message a `cause` deeper each time. 266 is the
 * one 2xx that carries an error, and it keeps its typed `ApiEndUserError`.
 */
describe('NodeProxyClient reports a 5xx as the DEPENDENCY failing, not as its own bug', () => {
    it('502 / 503 are the DEPENDENCY failing, so both become ApiDependencyError on this hop', async () => {
        stubApiErrorPayload(502, 'upstream refused');
        expect(await callAndCatch()).toBeInstanceOf(ApiDependencyError);

        stubApiErrorPayload(503, 'cold start');
        expect(await callAndCatch()).toBeInstanceOf(ApiDependencyError);
    });

    it('a 502 that ALREADY says ApiDependencyError is rethrown AS-IS, never double-wrapped', async () => {
        stubApiErrorPayload(502, 'upstream refused');

        const error = await callAndCatch();

        expect(error).toBeInstanceOf(ApiDependencyError);
        expect((error as Error).message).toBe('upstream refused');
        expect((error as Error).message).not.toContain('dependency answered');
    });

    it('a downstream 500 is the PEER broken, so THIS hop reports a dependency failure', async () => {
        stubApiErrorPayload(500, 'dependency blew up');

        const error = await callAndCatch();

        expect(error).toBeInstanceOf(ApiDependencyError);
        expect((error as Error).message).toContain('dependency blew up');
        expect(((error as Error).cause as Error).message).toBe('dependency blew up');
    });

    it('503 ApiDependencyBackoffError is still the peer failing, and its text survives', async () => {
        stubApiErrorPayload(503, 'dependency is rate limiting us', 'dependency-backoff');

        const error = await callAndCatch();

        expect(error).toBeInstanceOf(ApiDependencyError);
        expect((error as Error).message).toContain('dependency is rate limiting us');
    });

    /**
     * 266 (ApiEndUserError) cannot reach this seam AT ALL, and that is worth pinning: it is a 2xx, so
     * `response.ok` is true and the body goes down the SUCCESS path. The wrap could never have
     * touched it even if it wanted to.
     */
    it('266 reconstructs ApiEndUserError while retaining successful protocol monitoring', async () => {
        stubApiErrorPayload(266, 'that email is already taken');

        const result = await callAndCatch();

        expect(result).toBeInstanceOf(ApiEndUserError);
        expect((result as Error).message).toBe('that email is already taken');
    });
});

/**
 * Issue #948, client half: `edgeHttpStatus` rides the 266 body across a hop, and it never turns a real
 * 4xx on a hop into anything but this server's own 500.
 */
describe('NodeProxyClient and ApiEndUserError.edgeHttpStatus', () => {
    it('266 keeps edgeHttpStatus, errorCode and message for the next hop', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(() =>
                Promise.resolve(
                    new Response(
                        JSON.stringify({
                            kind: 'end-user',
                            message: 'That platform is not supported',
                            errorCode: 'report_unavailable',
                            edgeHttpStatus: 422,
                        }),
                        { status: 266, headers: { 'Content-Type': 'application/json' } },
                    ),
                ),
            ),
        );

        const result = await callAndCatch();

        expect(result).toBeInstanceOf(ApiEndUserError);
        expect(result).toMatchObject({
            message: 'That platform is not supported',
            errorCode: 'report_unavailable',
            edgeHttpStatus: 422,
        });
    });

    it('266 from an older peer (no field) decodes edgeHttpStatus as undefined', async () => {
        stubApiErrorPayload(266, 'pick a store');

        const result = await callAndCatch();

        expect(result).toBeInstanceOf(ApiEndUserError);
        expect((result as ApiEndUserError).edgeHttpStatus).toBeUndefined();
    });

    it('a real 404 on a hop (route missing) is still our own bug — unchanged', async () => {
        stubExpressHtml404();

        const error = await callAndCatch();

        expect(error).toBeInstanceOf(ApiImplementationError);
        expect(error).not.toBeInstanceOf(ApiEndUserError);
    });
});

/**
 * THE OPT-OUT, and there is only one: the app's `ErrorTranslator`, installed on `ClientRegistry` at
 * startup. A thin proxy or gateway that genuinely wants to relay a downstream status as its own says
 * so in one greppable line, and that decision wins here. There is deliberately NO ClientConfig flag
 * and NO webpieces.config.json key — a flag would make the dangerous choice invisible in the code
 * that suffers from it, whereas `grep -rn setErrorTranslator` lists every app that opted out.
 */
describe('an app-installed fromWire WINS over the uniform rule', () => {
    class RelayNotFound implements ErrorTranslator {
        private readonly fallback = new WebpiecesDefaultErrorTranslator();

        toWire(error: Error): HttpResponseDto {
            return this.fallback.toWire(error);
        }

        fromWire(response: HttpResponseDto): void {
            if (response.status.code !== 404) {
                this.fallback.fromWire(response); // not mine -> the webpieces default answers
                return;
            }
            throw new ApiNotFoundError((response.body as ApiErrorPayload).message ?? 'relayed 404');
        }
    }

    it('a 404 the app claims relays the downstream status as the app chose', async () => {
        ClientRegistry.setErrorTranslator(new RelayNotFound());
        stubApiErrorPayload(404, 'no such store');

        const error = await callAndCatch();

        expect(error).toBeInstanceOf(ApiNotFoundError);
        expect(error).not.toBeInstanceOf(ApiImplementationError);
        expect((error as Error).message).toBe('no such store');
    });

    it('a status the translator does NOT claim falls to the webpieces default', async () => {
        ClientRegistry.setErrorTranslator(new RelayNotFound());
        stubApiErrorPayload(403, 'our service account is not on the allow-list');

        const error = await callAndCatch();

        expect(error).toBeInstanceOf(ApiImplementationError);
        expect(((error as Error).cause as Error).message).toBe(
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
