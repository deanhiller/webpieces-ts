import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express, { Express, Request, Response } from 'express';
import { AddressInfo } from 'net';
import { Server } from 'http';
import { ApiClient, ApiFactory, WebpiecesConfig } from '@webpieces/http-routing';
import { WebpiecesExpressRouter } from '../WebpiecesExpressRouter';

/** Narrow shape of what the assertions need off a fetch Response. */
class CorsResponse {
    constructor(
        public readonly status: number,
        public readonly allowOrigin: string | null,
    ) {}
}

/** No webpieces routes — these tests exercise the GLOBAL middleware, not route dispatch. */
class NoRoutesApiFactory implements ApiFactory {
    public apiClients(): ApiClient[] {
        return [];
    }

    // webpieces-disable no-any-unknown -- must match the ApiFactory signature verbatim
    public createApiClient<T>(apiPrototype: abstract new (...args: any[]) => T): T {
        throw new Error(`No routes registered in this test: ${String(apiPrototype)}`);
    }
}

/**
 * Drives the REAL WebpiecesExpressRouter.bindAndStartExpress, so the cors MOUNT GATE itself is under
 * test — not a copy of it. The /echo route is added AFTER bindAndStartExpress on purpose: express
 * runs layers in registration order, so it lands behind the global middleware, exactly where a real
 * webpieces route sits.
 */
class CorsTestServer {
    private server?: Server;
    public baseUrl = '';

    public async start(config: WebpiecesConfig): Promise<void> {
        const app: Express = express();
        const router = new WebpiecesExpressRouter(new NoRoutesApiFactory());
        this.server = await router.bindAndStartExpress(app, 0, config);

        app.post('/echo', (req: Request, res: Response): void => {
            res.status(200).json({ ok: true });
        });

        const port = (this.server.address() as AddressInfo).port;
        this.baseUrl = `http://127.0.0.1:${port}`;
    }

    public async stop(): Promise<void> {
        const server = this.server;
        if (!server) {
            return;
        }
        await new Promise<void>((resolve: () => void) => server.close(() => resolve()));
    }

    public async post(origin?: string): Promise<CorsResponse> {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (origin) {
            headers['Origin'] = origin;
        }
        const res = await fetch(`${this.baseUrl}/echo`, { method: 'POST', headers, body: '{}' });
        return new CorsResponse(res.status, res.headers.get('access-control-allow-origin'));
    }
}

/**
 * THE PRODUCTION SHAPE: no corsOrigins, so cors is never mounted. This is the safe default, and it
 * still serves a browser app from the same origin — a browser applies no cors check to a same-origin
 * request. Nothing cross-origin is granted read access, in particular NOT localhost, which the old
 * unconditional corsForLocalhost() trusted even in production.
 */
describe('WebpiecesMiddleware CORS — not configured (production)', () => {
    const testServer = new CorsTestServer();

    beforeAll(async () => {
        await testServer.start(new WebpiecesConfig());
    });
    afterAll(async () => {
        await testServer.stop();
    });

    it('serves a same-origin POST — the browser app works with NO cors at all', async () => {
        // The bug this replaces: the old middleware turned this exact request into a 500 in prod.
        expect((await testServer.post(testServer.baseUrl)).status).toBe(200);
    });

    it('serves a no-Origin request (curl / server-to-server / CLI)', async () => {
        expect((await testServer.post()).status).toBe(200);
    });

    it('grants NO cross-origin read access to localhost — not trusted in prod', async () => {
        // No Access-Control-Allow-Origin => the browser refuses to hand the response to the page, so
        // a page on the victim's localhost cannot read a production api's responses.
        expect((await testServer.post('http://localhost:4200')).allowOrigin).toBeNull();
    });

    it('grants NO cross-origin read access to a hostile origin', async () => {
        expect((await testServer.post('https://evil.example.com')).allowOrigin).toBeNull();
    });
});

/** CORS explicitly turned on: dev (`ng serve`), and/or a UI hosted on a different host. */
describe('WebpiecesMiddleware CORS — configured', () => {
    const testServer = new CorsTestServer();

    beforeAll(async () => {
        const config = new WebpiecesConfig();
        config.corsOrigins = ['http://localhost:*', 'https://ui.example.com'];
        await testServer.start(config);
    });
    afterAll(async () => {
        await testServer.stop();
    });

    it('allows the SERVER OWN origin, so mounting cors never breaks the server own UI', async () => {
        const res = await testServer.post(testServer.baseUrl);
        expect(res.status).toBe(200);
        expect(res.allowOrigin).toBe(testServer.baseUrl);
    });

    it('allows same-origin even when the scheme differs (TLS-terminating proxy)', async () => {
        // Cloud Run terminates TLS: req.protocol is http, but the browser Origin says https. Comparing
        // full origins would 403 the server's own UI on every deploy — we compare HOST only.
        const host = testServer.baseUrl.replace('http://', '');
        expect((await testServer.post(`https://${host}`)).status).toBe(200);
    });

    it('allows any port on a :* entry — the angular dev-server port moves', async () => {
        const res = await testServer.post('http://localhost:4201');
        expect(res.status).toBe(200);
        expect(res.allowOrigin).toBe('http://localhost:4201');
    });

    it('allows an exactly-listed origin', async () => {
        const res = await testServer.post('https://ui.example.com');
        expect(res.status).toBe(200);
        expect(res.allowOrigin).toBe('https://ui.example.com');
    });

    it('does NOT let the :* wildcard span a host', async () => {
        // http://localhost:* must never match http://localhost.evil.com
        expect((await testServer.post('http://localhost.evil.com')).status).toBe(403);
    });

    it('blocks an unlisted origin with a clean 403, NOT a 500', async () => {
        const res = await testServer.post('https://evil.example.com');
        expect(res.status).toBe(403);
        expect(res.allowOrigin).toBeNull();
    });

    it('blocks a malformed Origin rather than throwing', async () => {
        expect((await testServer.post('not-a-url')).status).toBe(403);
    });
});
