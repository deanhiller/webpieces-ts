import 'reflect-metadata';
import { WebpiecesServer, WebpiecesFactory } from '@webpieces/http-server';
import { WebpiecesConfig } from '@webpieces/http-routing';
import { SaveResponse } from '@webpieces/client-server-api';
import { ProdServerMeta } from '../../client-server/src/ProdServerMeta';
import { Server2Meta } from '../../server2/src/Server2Meta';

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
 * The caller sends x-correlation-id (the transaction id) + x-tenant-id.
 * Assertions:
 * - BOTH servers' [API-SVR-req] log lines contain correlationId=txn-... (the
 *   context logging works end-to-end)
 * - server2's log shows previousId = client-server's request id (per-hop chain)
 * - the secured authorization header is MASKED in logs, never the raw token
 * - the response echo proves tenant + chain arrived at hop 2
 *
 * Test ports 18200/18202 avoid clashing with dev servers on 8200/8202.
 */
const clientServerPort = 18200;
const server2Port = 18202;
let clientServer: WebpiecesServer;
let server2: WebpiecesServer;
let logLines: string[];
let logSpy: ReturnType<typeof vi.spyOn>;

async function bootBothServers(): Promise<void> {
    // client-server's InversifyModule reads SERVER2_URL for its outbound client
    process.env['SERVER2_URL'] = `http://localhost:${server2Port}`;

    server2 = await WebpiecesFactory.create(new Server2Meta(), new WebpiecesConfig());
    await server2.start(server2Port);

    clientServer = await WebpiecesFactory.create(new ProdServerMeta(), new WebpiecesConfig());
    await clientServer.start(clientServerPort);

    // Capture BOTH servers' log output (they share this test process)
    logLines = [];
    logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
        logLines.push(args.map((a: unknown) => String(a)).join(' '));
    });
}

async function stopBothServers(): Promise<void> {
    logSpy.mockRestore();
    delete process.env['SERVER2_URL'];
    await clientServer.stop();
    await server2.stop();
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
