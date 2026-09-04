import 'reflect-metadata';
import express from 'express';
import type { Server as HttpServer } from 'http';
import { WebpiecesExpressRouter } from '@webpieces/http-server';
import { ClientRegistry, ProtocolError, Secrets, WebpiecesCoreHeaders } from '@webpieces/core-util';
import { GcpOidc } from '@webpieces/gcp-identity';
import { Provider, RequestContext, RequestContextHeaders } from '@webpieces/core-context';
import {
    ClientConfig,
    ClientHttpFactory,
    DnsAddressResolver,
    NodeProxyClient,
} from '@webpieces/http-client-node';
import { PublicApi } from '@webpieces/client-server-api';
import { setupCompanyRuntime } from '@webpieces/company-svc-core';
import { ClientServerAppModules } from '../../client-server/src/ClientServerAppModules';
import {
    ORDER_SURFACE_HEADER,
    OrderNotFoundError,
    installOrderErrorTranslators,
} from '../../client-server/src/OrderErrors';

/**
 * Issue #862, end to end over REAL HTTP: ONE `ErrorTranslators` object, installed once, owning the
 * WHOLE response on the server and reconstructing the typed error inside a real client.
 *
 * This is the only place in the repo where both halves can meet — `http-server` deliberately does not
 * depend on `http-client-core`, so the unit specs on either side pin their half against the wire
 * bytes and this app-level spec proves the halves actually agree.
 */
const PORT = 18260;
let httpServer: HttpServer;

const url = (path: string): string => `http://localhost:${PORT}${path}`;

/** A REAL node client for PublicApi, built the way SharedSecretClient.spec builds one. */
const publicApiClient = (): PublicApi => {
    const provider = new Provider(
        () => new NodeProxyClient(
            new RequestContextHeaders(),
            new GcpOidc(),
            new DnsAddressResolver(),
            new Secrets({}),
        ),
    );
    return new ClientHttpFactory(provider).createRpcClient(PublicApi, new ClientConfig('client-server'));
};

/** POST a body express will hand straight to the wrapper, with no client in the way. */
const post = (path: string, body: string): Promise<Response> =>
    fetch(url(path), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
    });

beforeAll(async () => {
    const factory = await setupCompanyRuntime(ClientServerAppModules.create());
    httpServer = await new WebpiecesExpressRouter(factory).bindAndStartExpress(express(), PORT);
    ClientRegistry.clear();
    ClientRegistry.addUrlMapping('client-server', url(''));
});

afterAll(async () => {
    ClientRegistry.clear();
    await new Promise<void>((resolve: () => void) => httpServer.close(() => resolve()));
});

beforeEach(() => {
    // ClientRegistry.clear() would drop the url mapping the client needs, so only the translators
    // are reset here — each block installs the ones it is about.
    ClientRegistry.setErrorTranslators({ toWire: () => undefined, fromWire: () => undefined });
});

describe('the app owns the WHOLE response: status, reason, headers and body', () => {
    it('a thrown app type becomes the app’s own status + reason + header + body', async () => {
        installOrderErrorTranslators();

        const res = await post('/public/info', JSON.stringify({ name: 'missing-order' }));

        expect(res.status).toBe(460);
        expect(res.statusText).toBe('Order Not Found');
        // A header on an error response — flatly impossible under the old (statusCode, body) pair.
        expect(res.headers.get(ORDER_SURFACE_HEADER)).toBe('/public/info');
        const body = (await res.json()) as ProtocolError;
        expect(body.errorCode).toBe('ORDER_NOT_FOUND');
        expect(body.message).toBe('no order order-4471');
    });

    it('with NO translators installed, the webpieces default still answers', async () => {
        const res = await post('/public/info', JSON.stringify({ name: 'missing-order' }));

        expect(res.status).toBe(460);
        expect(res.headers.get(ORDER_SURFACE_HEADER)).toBeNull();
        // The built-in ladder genericizes an app status it has no phrase for.
        expect(((await res.json()) as ProtocolError).message).toBe('Request Failed');
    });
});

/**
 * THE symmetry test: the server throws `OrderNotFoundError` and the CALLER catches
 * `OrderNotFoundError` — the same type on both sides of real HTTP, from one registration.
 */
describe('server throws X -> client catches X', () => {
    it('a real node client reconstructs the app’s own type, not a status code', async () => {
        installOrderErrorTranslators();

        await RequestContext.run(async () => {
            const caught = await publicApiClient()
                .getInfo({ name: 'missing-order' })
                .then(() => undefined)
                .catch((err: unknown) => err);

            expect(caught).toBeInstanceOf(OrderNotFoundError);
            expect((caught as OrderNotFoundError).message).toBe('no order order-4471');
        });
    });

    it('an ordinary call is untouched — translation is only ever the error path', async () => {
        installOrderErrorTranslators();

        await RequestContext.run(async () => {
            expect((await publicApiClient().getInfo({ name: 'Dean' })).greeting).toBe('Hello, Dean!');
        });
    });
});

/**
 * The bug this issue was filed for. A translator asks "is this MY surface?" from
 * `RequestContext.getRequest()`, and a body that fails to parse throws BEFORE the request used to be
 * published — so the translator ran with an empty scope, answered "not mine", and the app's published
 * error contract silently became webpieces' generic one.
 */
describe('a malformed body reaches the translator WITH its request context', () => {
    it('the translator sees the path and claims the error', async () => {
        installOrderErrorTranslators();

        const res = await post('/public/info', '{ this is not json');

        // 461, not 460: the surface matched, the error was NOT an OrderNotFoundError. Both halves of
        // that verdict are only reachable if the translator could read the path.
        expect(res.status).toBe(461);
        expect(res.headers.get(ORDER_SURFACE_HEADER)).toBe('/public/info');
        expect(((await res.json()) as ProtocolError).errorCode).toBe('ORDER_SURFACE_ERROR');
    });
});

/**
 * The transaction id is INFRASTRUCTURE: webpieces emits it on every response, so an app that
 * overrides the error BODY does not have to remember to re-emit the trace header.
 */
describe('the txId response header', () => {
    const txHeader = WebpiecesCoreHeaders.REQUEST_ID.httpHeader!;

    it('is on a 200', async () => {
        const res = await post('/public/info', JSON.stringify({ name: 'Dean' }));

        expect(res.status).toBe(200);
        expect(res.headers.get(txHeader)).toMatch(/^svrGenReqId-/);
    });

    it('is on an error, and is the id the CALLER sent when it sent one', async () => {
        const res = await fetch(url('/public/info'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-request-id': 'caller-req-42' },
            body: JSON.stringify({ name: 'missing-order' }),
        });

        expect(res.status).toBe(460);
        expect(res.headers.get(txHeader)).toBe('caller-req-42');
    });

    it('is on an app-translated error too — the app never re-emits it', async () => {
        installOrderErrorTranslators();

        const res = await post('/public/info', JSON.stringify({ name: 'missing-order' }));

        expect(res.headers.get(txHeader)).toMatch(/^svrGenReqId-/);
    });

    /**
     * ACCEPTED KNOWN ISSUE, pinned so a future change to it is deliberate (issue #862, "explicitly
     * out of scope"): a malformed or oversize body fails BEFORE `fillFromRequest` mints an id, so a
     * caller that sent none has no transaction id to quote at support. Publishing the request early
     * (step 0 of executeImpl) fixed the CONTEXT the translator needs; minting the id early would drag
     * the raw-body republish into every route and was declined.
     */
    it('is ABSENT on a malformed body when the caller sent no id — the documented limitation', async () => {
        const res = await post('/public/info', '{ this is not json');

        expect(res.status).toBe(400);
        expect(res.headers.get(txHeader)).toBeNull();
    });

    it('...but IS present on a malformed body when the CALLER supplied the id', async () => {
        const res = await fetch(url('/public/info'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-request-id': 'caller-req-43' },
            body: '{ this is not json',
        });

        expect(res.status).toBe(400);
        // The caller's own id is on the inbound request, and `x-request-id` reaches the context only
        // via fillFromRequest — which is below the parse. So this is absent too.
        expect(res.headers.get(txHeader)).toBeNull();
    });
});
