import 'reflect-metadata';
import express from 'express';
import type { Server as HttpServer } from 'http';
import { WebpiecesExpressRouter } from '@webpieces/http-server';
import { SaveResponse } from '@webpieces/client-server-api';
import { buildClientServerApiFactory } from '../../client-server/src/AppServerConfig';
import { buildServer2ApiFactory } from '../../server2/src/Server2Config';

/**
 * THE full-flow example test: two real microservices, real HTTP between them,
 * and proof that the magic context ("transaction id") flows through BOTH
 * servers' logs.
 *
 *   test --HTTP--> client-server :18200  (implements client-server-api)
 *                      |  Server2Api = createApiClient (ContextMgr reads the
 *                      |  server's RequestContext -> outbound headers)
 *                      +--HTTP--> server2 :18202  (implements server2-api)
 *
 * Each server is built with its app-owned ApiFactory builder (buildXxxApiFactory — the SAME
 * one its own main + tests use) and served over an app-owned express via WebpiecesExpressRouter
 * (bindAndStartExpress) — the same production path, just with the test owning express.
 *
 * Test ports 18200/18202 avoid clashing with dev servers on 8200/8202.
 */
const clientServerPort = 18200;
const server2Port = 18202;
let clientServerHttp: HttpServer;
let server2Http: HttpServer;
let logLines: string[];
let logSpy: ReturnType<typeof vi.spyOn>;

async function bootBothServers(): Promise<void> {
    // client-server's InversifyModule reads SERVER2_URL for its outbound client
    process.env['SERVER2_URL'] = `http://localhost:${server2Port}`;

    // One process, one global HeaderRegistry serving TWO servers. Build server2 FIRST (no
    // app-specific headers) and client-server LAST (it carries the header superset), so the
    // shared global registry ends configured as the UNION both servers need.
    const server2ApiFactory = await buildServer2ApiFactory();
    server2Http = await new WebpiecesExpressRouter(server2ApiFactory).bindAndStartExpress(express(), server2Port);

    const clientApiFactory = await buildClientServerApiFactory();
    clientServerHttp = await new WebpiecesExpressRouter(clientApiFactory).bindAndStartExpress(express(), clientServerPort);

    // Capture BOTH servers' log output (they share this test process)
    logLines = [];
    logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
        logLines.push(args.map((a: unknown) => String(a)).join(' '));
    });
}

async function stopBothServers(): Promise<void> {
    logSpy.mockRestore();
    delete process.env['SERVER2_URL'];
    await new Promise<void>((resolve: () => void) => clientServerHttp.close(() => resolve()));
    await new Promise<void>((resolve: () => void) => server2Http.close(() => resolve()));
}

describe('Full flow: caller -> client-server -> server2 with context logging', () => {
    beforeAll(bootBothServers);
    afterAll(stopBothServers);

    it('transaction id (x-correlation-id) appears in BOTH servers logs; chain + masking verified', async () => {
        const transactionId = 'txn-e2e-12345';

        const res = await fetch(`http://localhost:${clientServerPort}/search/item`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'authorization': 'secret-token-abcdef',
                'x-correlation-id': transactionId,
                'x-tenant-id': 'tenant-99',
                'x-request-id': 'caller-req-1',
            },
            body: JSON.stringify({ query: 'full-flow' }),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as SaveResponse;
        expect(body.success).toBe(true);

        // --- Log validation: the transaction id flowed through BOTH hops ---
        const hop1Log = logLines.find((l: string) =>
            l.includes('[API-SVR-req] SaveController.save') && l.includes(`"correlationId":"${transactionId}"`));
        expect(hop1Log).toBeDefined();

        const hop2Log = logLines.find((l: string) =>
            l.includes('[API-SVR-req] Server2Controller.fetchValue') && l.includes(`"correlationId":"${transactionId}"`));
        expect(hop2Log).toBeDefined();

        // hop 2 also logs tenant and the request-id CHAIN: previousId = hop 1's own id
        expect(hop2Log).toContain('"tenantId":"tenant-99"');
        const hop1RequestId = /"requestId":"([^"]+)"/.exec(hop1Log!)![1];
        expect(hop2Log).toContain(`"previousId":"${hop1RequestId}"`);

        // secured authorization is MASKED in every log line - raw token never appears
        const leaked = logLines.filter((l: string) => l.includes('secret-token-abcdef'));
        expect(leaked).toEqual([]);
        expect(hop2Log).toContain('"authorization":"sec...def"');

        // --- Response echo: proves the context ARRIVED at hop 2, not just logs ---
        const echo = body.matches![0].description!;
        expect(echo).toContain('tenant=tenant-99');
        expect(echo).toContain(`previousId=${hop1RequestId}`);
        expect(echo).not.toContain('requestId=caller-req-1;'); // hop 2 got its OWN id
    });
});
