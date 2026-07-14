import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express, { Express, Request, Response } from 'express';
import { AddressInfo } from 'net';
import { Server } from 'http';
import { WebpiecesConfig } from '@webpieces/http-routing';
import { WebpiecesMiddleware } from '../WebpiecesMiddleware';

/** Narrow shape of what the assertions need off a fetch Response. */
class CorsResponse {
    constructor(
        public readonly status: number,
        public readonly allowOrigin: string | null,
    ) {}
}

/** A real express server behind the real corsMiddleware — no mocks, so this pins actual browser behavior. */
class CorsTestServer {
    private server?: Server;
    public baseUrl = '';

    public async start(config: WebpiecesConfig): Promise<void> {
        const app: Express = express();
        app.use(new WebpiecesMiddleware().corsMiddleware(config));
        app.post('/echo', (req: Request, res: Response): void => {
            res.status(200).json({ ok: true });
        });

        this.server = await new Promise<Server>((resolve: (s: Server) => void) => {
            const s: Server = app.listen(0, () => resolve(s));
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
 * CORS regression suite. The bug this pins: the old corsForLocalhost() allowed ONLY localhost:*
 * origins and rejected everything else with callback(new Error(...)) -> a 500. Browsers send an
 * Origin header on EVERY POST, even same-origin, and every webpieces route is a POST — so the moment
 * a webpieces server served its own browser app in production, every single api call 500'd.
 */
describe('WebpiecesMiddleware CORS', () => {
    const testServer = new CorsTestServer();

    beforeAll(async () => {
        const config = new WebpiecesConfig();
        config.corsOrigins = ['https://ui.example.com'];
        await testServer.start(config);
    });

    afterAll(async () => {
        await testServer.stop();
    });

    it('allows a request with NO Origin (curl / server-to-server / CLI)', async () => {
        expect((await testServer.post()).status).toBe(200);
    });

    it('allows the SERVER OWN origin — the production bug', async () => {
        // The browser posts to the same host it loaded the app from, so Origin === the server's host.
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

    it('allows localhost:* (dev)', async () => {
        expect((await testServer.post('http://localhost:4201')).status).toBe(200);
    });

    it('allows an origin listed in config.corsOrigins', async () => {
        const res = await testServer.post('https://ui.example.com');
        expect(res.status).toBe(200);
        expect(res.allowOrigin).toBe('https://ui.example.com');
    });

    it('blocks an unknown origin with a clean 403, NOT a 500', async () => {
        const res = await testServer.post('https://evil.example.com');
        expect(res.status).toBe(403);
        expect(res.allowOrigin).toBeNull();
    });

    it('blocks a malformed Origin rather than throwing', async () => {
        expect((await testServer.post('not-a-url')).status).toBe(403);
    });
});
