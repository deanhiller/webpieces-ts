import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import express from 'express';
import { AddressInfo } from 'net';
import { Server as HttpServer } from 'http';
import { ApiEndUserError, HeaderRegistry, RouteMetadata } from '@webpieces/core-util';
import { ApiClient, ApiFactory } from '@webpieces/http-routing';
import { WebpiecesExpressRouter } from '../WebpiecesExpressRouter';
import { EndUserStatus } from '../ApiErrorHttpMapper';

/**
 * Issue #948: `WebpiecesExpressRouter.setEndUserStatus` must actually reach every mounted route. The
 * status mapping itself is pinned in `ApiErrorHttpMapper.spec.ts`; this spec proves the router's
 * choice survives the trip through `WebpiecesMiddleware.createExpressWrapper` over real HTTP.
 */
class RefusingApi {}

/** One route whose proxy always refuses the end user with the status the throw site chose. */
class RefusingApiFactory implements ApiFactory {
    apiClients(): ApiClient[] {
        // webpieces-disable no-any-unknown -- request DTOs are erased at the routing boundary
        const refuse = (_dto: unknown): Promise<unknown> =>
            Promise.reject(new ApiEndUserError('No such report', 'report_not_found', 404));
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

    async start(endUserStatus?: EndUserStatus): Promise<string> {
        const app = express();
        const router = new WebpiecesExpressRouter(new RefusingApiFactory());
        if (endUserStatus !== undefined) {
            router.setEndUserStatus(endUserStatus);
        }
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

describe('WebpiecesExpressRouter.setEndUserStatus', () => {
    it('defaults to GUI mode: 266 with the message, code and edgeHttpStatus in the body', async () => {
        const res = await harness.post(await harness.start());

        expect(res.status).toBe(266);
        expect(await res.json()).toMatchObject({
            kind: 'end-user',
            message: 'No such report',
            errorCode: 'report_not_found',
            edgeHttpStatus: 404,
        });
    });

    it("'edge' answers the thrower's edgeHttpStatus", async () => {
        const res = await harness.post(await harness.start('edge'));

        expect(res.status).toBe(404);
        expect(await res.json()).toMatchObject({
            kind: 'end-user',
            message: 'No such report',
            errorCode: 'report_not_found',
        });
    });

    it('refuses a choice made after bindExpress', () => {
        const router = new WebpiecesExpressRouter(new RefusingApiFactory());
        router.bindExpress(express());

        expect(() => router.setEndUserStatus('edge')).toThrow(
            'Call setEndUserStatus() before bindExpress(app)',
        );
    });
});
