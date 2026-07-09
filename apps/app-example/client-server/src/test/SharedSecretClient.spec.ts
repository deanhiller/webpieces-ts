import 'reflect-metadata';
import express from 'express';
import type { Server as HttpServer } from 'http';
import { ContainerModule, ContainerModuleLoadOptions } from 'inversify';
import { WebpiecesExpressRouter } from '@webpieces/http-server';
import { AuthConfig } from '@webpieces/http-routing';
import { Secrets } from '@webpieces/core-util';
import { ClientHttpFactory, ClientConfig } from '@webpieces/http-client';
import { mintIdToken } from '@webpieces/gcp-identity';
import { SecureApi } from '@webpieces/client-server-api';
import { buildClientServerApiFactory, ClientServerApiFactoryOptions } from '../AppServerConfig';
import { TestAuthConfig } from './TestAuthConfig';

/**
 * Proves the CLIENT ↔ SERVER shared-secret symmetry over REAL HTTP:
 *  - the http-client ATTACHES the value from its bound {@link Secrets} (x-webpieces-shared-secret),
 *  - the server ACCEPTS EITHER of the two {@link SharedSecrets} it holds for the key (rotation).
 * No process.env is read on either side — the secrets are literals bound per-test, so this runs
 * in parallel with everything else. (TestAuthConfig binds INTERNAL_API_SECRET →
 * SharedSecrets('some-test-key','some-test-key-rotating').)
 */
const PORT = 18250;
let httpServer: HttpServer;

beforeAll(async () => {
    const authOverride = new ContainerModule(async (o: ContainerModuleLoadOptions) => {
        (await o.rebind(AuthConfig)).to(TestAuthConfig);
    });
    const factory = await buildClientServerApiFactory(new ClientServerApiFactoryOptions(undefined, authOverride));
    httpServer = await new WebpiecesExpressRouter(factory).bindAndStartExpress(express(), PORT);
});

afterAll(async () => {
    await new Promise<void>((resolve: () => void) => httpServer.close(() => resolve()));
});

/** An http-client for SecureApi whose bound Secrets sends `value` for the INTERNAL_API_SECRET key. */
function clientSending(value: string): SecureApi {
    // The Secrets are a FACTORY dependency, so each distinct secret needs its own factory —
    // in prod there is exactly one factory per service. SecureApi has an @AuthOidc endpoint,
    // so a minter is required at construction (unused here).
    const factory = new ClientHttpFactory(undefined, mintIdToken, new Secrets({ INTERNAL_API_SECRET: value }));
    return factory.createClient(SecureApi, new ClientConfig(`http://localhost:${PORT}`));
}

describe('shared-secret over HTTP: client sends from Secrets, server accepts either', () => {
    it('client sending secret1 is accepted (200)', async () => {
        const res = await clientSending('some-test-key').internalOp({});
        expect(res.ok).toBe(true);
    });

    it('client sending secret2 (the rotating value) is ALSO accepted — zero-downtime rotation', async () => {
        const res = await clientSending('some-test-key-rotating').internalOp({});
        expect(res.ok).toBe(true);
    });

    it('client sending a wrong secret is rejected', async () => {
        await expect(clientSending('not-the-secret').internalOp({})).rejects.toThrow();
    });
});
