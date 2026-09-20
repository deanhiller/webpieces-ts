import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import express from 'express';
import { AddressInfo } from 'net';
import { Server as HttpServer } from 'http';
import {
    ApiEndUserError,
    HeaderRegistry,
    RouteMetadata,
    Surface,
    WebpiecesCoreHeaders,
} from '@webpieces/core-util';
import { RequestContext } from '@webpieces/core-context';
import { ApiClient, ApiFactory } from '@webpieces/http-routing';
import { WebpiecesExpressRouter } from '../WebpiecesExpressRouter';

/**
 * Issue #948, reworked by #968. `WebpiecesExpressRouter.setEndUserStatus` is GONE: the same endpoint
 * is reached by a GUI, by an LLM through the MCP bridge and by a partner against a published REST
 * contract, so 266-or-real-4xx was never something a ROUTER could know. It is derived per request
 * from `WebpiecesCoreHeaders.SURFACE`, which `AuthFilter` stamps from the auth mode that matched.
 *
 * This spec proves the DERIVATION reaches every mounted route over real HTTP. `AuthFilter`'s own
 * stamping and the trusted-header refusal are pinned in http-routing's `SurfaceContextKey.spec.ts`;
 * the status table itself is pinned in core-util's `WebpiecesDefaultErrorTranslator.spec.ts`.
 */
class RefusingApi {}

/** One route whose proxy always refuses the end user with the status the throw site chose. */
class RefusingApiFactory implements ApiFactory {
    constructor(private readonly surface?: Surface) {}

    apiClients(): ApiClient[] {
        // webpieces-disable no-any-unknown -- request DTOs are erased at the routing boundary
        const refuse = (_dto: unknown): Promise<unknown> => {
            // Stands in for AuthFilter, which is not mounted by this hand-built ApiFactory: it puts
            // exactly this key, from exactly this kind of decision, before the controller runs.
            if (this.surface !== undefined) {
                RequestContext.putTrusted(WebpiecesCoreHeaders.SURFACE, this.surface);
            }
            return Promise.reject(new ApiEndUserError('No such report', 'report_not_found', 404));
        };
        const routes = [
            new RouteMetadata(
                'POST',
                '/report',
                'report',
                undefined,
                undefined,
                'RefusingApi',
                false,
                undefined,
                false,
                [],
                0,
            ),
        ];
        return [new ApiClient(RefusingApi, { report: refuse }, routes)];
    }

    createApiClient<T>(): T {
        throw new Error('not used by these tests');
    }
}

class RouterHarness {
    server?: HttpServer;

    async start(surface?: Surface): Promise<string> {
        const app = express();
        const router = new WebpiecesExpressRouter(new RefusingApiFactory(surface));
        router.bindExpress(app);
        this.server = await new Promise<HttpServer>((resolve: (s: HttpServer) => void) => {
            const s: HttpServer = app.listen(0, () => resolve(s));
        });
        const port = (this.server.address() as AddressInfo).port;
        return `http://127.0.0.1:${port}/report`;
    }

    async post(url: string): Promise<globalThis.Response> {
        return fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
            signal: AbortSignal.timeout(3000),
        });
    }

    stop(): Promise<void> {
        return new Promise<void>((resolve: () => void) => {
            if (!this.server) {
                resolve();
                return;
            }
            this.server.closeAllConnections();
            this.server.close(() => resolve());
        });
    }
}

const harness = new RouterHarness();

beforeAll(() => {
    if (!HeaderRegistry.isConfigured()) {
        HeaderRegistry.configure([], true);
    }
});

afterEach(async () => {
    await harness.stop();
});

describe('end-user status is derived from the caller SURFACE, per request', () => {
    it('NO surface established: 266 with the message, code and edgeHttpStatus in the body', async () => {
        const res = await harness.post(await harness.start());

        expect(res.status).toBe(266);
        expect(await res.json()).toMatchObject({
            kind: 'end-user',
            message: 'No such report',
            errorCode: 'report_not_found',
            edgeHttpStatus: 404,
        });
    });

    it('gui: 266 — the browser client decodes the body and shows the message', async () => {
        const res = await harness.post(await harness.start('gui'));

        expect(res.status).toBe(266);
        expect(await res.json()).toMatchObject({ kind: 'end-user', message: 'No such report' });
    });

    it('llm: 266 — the MCP bridge calls through ApiFactory and renders the result itself', async () => {
        const res = await harness.post(await harness.start('llm'));

        expect(res.status).toBe(266);
        expect(await res.json()).toMatchObject({ kind: 'end-user', message: 'No such report' });
    });

    it("public-api: the thrower's edgeHttpStatus, because a partner contract promises real statuses", async () => {
        const res = await harness.post(await harness.start('public-api'));

        expect(res.status).toBe(404);
        expect(await res.json()).toMatchObject({
            kind: 'end-user',
            message: 'No such report',
            errorCode: 'report_not_found',
        });
    });

    it('the router has no setEndUserStatus to call any more — the surface decides', () => {
        const router = new WebpiecesExpressRouter(new RefusingApiFactory());

        expect((router as unknown as Record<string, unknown>)['setEndUserStatus']).toBeUndefined();
    });
});
