import 'reflect-metadata';
import express from 'express';
import type { Server as HttpServer } from 'http';
import { ContainerModule, ContainerModuleLoadOptions } from 'inversify';
import { WebpiecesExpressRouter } from '@webpieces/http-server';
import { AuthConfig, JwtHook } from '@webpieces/http-routing';
import { SaveResponse } from '@webpieces/client-server-api';
import { buildClientServerApiFactory, ClientServerApiFactoryOptions } from '../../client-server/src/AppServerConfig';
import { buildServer2ApiFactory } from '../../server2/src/Server2Config';
import { TestAuthConfig, TestJwtHook } from '../../client-server/src/test/TestAuthConfig';

/**
 * THE full-flow example test: two real microservices, real HTTP between them,
 * and proof that the magic context ("transaction id") flows through BOTH
 * servers' logs.
 *
 *   test --HTTP--> client-server :18200  (implements client-server-api)
 *                      |  Server2Api = ClientHttpFactory (ContextMgr reads the
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

    // Rebind AuthConfig to the test stub so the request's bearer token passes the framework
    // AuthFilter (this test is about context propagation, not real JWT verification).
    const authOverride = new ContainerModule(async (options: ContainerModuleLoadOptions) => {
        (await options.rebind(AuthConfig)).to(TestAuthConfig);
        (await options.rebind(JwtHook)).to(TestJwtHook);
    });
    const clientApiFactory = await buildClientServerApiFactory(new ClientServerApiFactoryOptions(undefined, authOverride));
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

    it('context reaches BOTH hops unchanged, and the credential never leaves hop 1', async () => {
        const res = await fetch(`http://localhost:${clientServerPort}/search/item`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'authorization': 'Bearer secret-token-abcdef',
                'x-tenant-id': 'tenant-99',
                'x-request-id': 'caller-req-1',
            },
            body: JSON.stringify({ query: 'full-flow' }),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as SaveResponse;
        expect(body.success).toBe(true);

        // --- Both hops actually ran (LogApiCall logs the request line on each server) ---
        // These lines carry NO context fields: LogApiCall no longer stringifies a header map, and
        // the bootstrap ConsoleLogger stamps none. A real backend (bunyan/winston) reads
        // RequestContext.buildLogFields() per record. Context is therefore verified via the echo.
        expect(logLines.some((l: string) => l.includes('[API-SVR-req] SaveController.save'))).toBe(true);
        expect(logLines.some((l: string) => l.includes('[API-SVR-req] Server2Controller.fetchValue'))).toBe(true);

        // The credential NEVER leaves hop 1. `authorization` is read off the inbound HttpRequest and
        // is not a ContextKey, so it never enters the RequestContext, is never logged, and is never
        // transferred to server2. (It used to travel, masked, into hop 2's log line.)
        expect(logLines.filter((l: string) => l.includes('secret-token-abcdef'))).toEqual([]);
        expect(logLines.filter((l: string) => l.includes('authorization'))).toEqual([]);

        // --- Response echo from hop 2: proves the context ARRIVED, not merely that it was logged ---
        const echo = body.matches![0].description!;
        expect(echo).toContain('tenant=tenant-99');            // company header crossed the hop
        // ONE id for the whole call tree: the caller's x-request-id reached hop 2 UNCHANGED.
        // Nobody rewrote it, nobody minted a second one.
        expect(echo).toContain('requestId=caller-req-1');
    });
});
