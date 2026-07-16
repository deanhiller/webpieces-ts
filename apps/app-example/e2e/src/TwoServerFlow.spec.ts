import 'reflect-metadata';
import express from 'express';
import type { Server as HttpServer } from 'http';
import { ContainerModule, ContainerModuleLoadOptions } from 'inversify';
import { WebpiecesExpressRouter } from '@webpieces/http-server';
import { AUTH_CONFIG, JWT_HOOK } from '@webpieces/http-routing';
import { SaveResponse } from '@webpieces/client-server-api';
import { ClientRegistry } from '@webpieces/core-util';
import { setupCompanyRuntime, CompanySetupOptions } from '@webpieces/company-svc-core';
import { ClientServerAppModules } from '../../client-server/src/ClientServerAppModules';
import { Server2AppModules } from '../../server2/src/Server2AppModules';
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
 * Each server is built from its app-owned AppModules (XxxAppModules.create() — the SAME
 * declaration its own main + tests use) via setupCompanyRuntime, and served over an app-owned
 * express via WebpiecesExpressRouter (bindAndStartExpress) — the same production path, just with
 * the test owning express.
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
    // client-server's outbound Server2Api client resolves 'server2' via the local registry (off-GCP).
    ClientRegistry.clear();
    ClientRegistry.addUrlMapping('server2', `http://localhost:${server2Port}`);

    // One process, one global HeaderRegistry serving TWO servers. Build server2 FIRST (no
    // app-specific headers) and client-server LAST (it carries the header superset), so the
    // shared global registry ends configured as the UNION both servers need.
    const server2ApiFactory = await setupCompanyRuntime(Server2AppModules.create());
    server2Http = await new WebpiecesExpressRouter(server2ApiFactory).bindAndStartExpress(express(), server2Port);

    // Rebind AuthConfig to the test stub so the request's bearer token passes the framework
    // AuthFilter (this test is about context propagation, not real JWT verification).
    const authOverride = new ContainerModule(async (options: ContainerModuleLoadOptions) => {
        (await options.rebind(AUTH_CONFIG)).to(TestAuthConfig);
        (await options.rebind(JWT_HOOK)).to(TestJwtHook);
    });
    const clientApiFactory = await setupCompanyRuntime(ClientServerAppModules.create(), new CompanySetupOptions(undefined, authOverride));
    clientServerHttp = await new WebpiecesExpressRouter(clientApiFactory).bindAndStartExpress(express(), clientServerPort);

    // Capture BOTH servers' log output (they share this test process)
    logLines = [];
    logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
        logLines.push(args.map((a: unknown) => String(a)).join(' '));
    });
}

async function stopBothServers(): Promise<void> {
    logSpy.mockRestore();
    ClientRegistry.clear();
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
        // The identity is the API CONTRACT class (SaveApi / Server2Api), NOT the controller impl —
        // so a server log line MATCHES the client's for the same call (jsonPayload.api.method.apiClass).
        expect(logLines.some((l: string) => l.includes('[API-server-req] SaveApi.save'))).toBe(true);
        expect(logLines.some((l: string) => l.includes('[API-server-req] Server2Api.fetchValue'))).toBe(true);

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
