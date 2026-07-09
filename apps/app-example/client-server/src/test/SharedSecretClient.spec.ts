import 'reflect-metadata';
import express from 'express';
import type { Server as HttpServer } from 'http';
import { ContainerModule, ContainerModuleLoadOptions } from 'inversify';
import { WebpiecesExpressRouter } from '@webpieces/http-server';
import { AuthConfig } from '@webpieces/http-routing';
import { Secrets } from '@webpieces/core-util';
import { Provider, RequestContext, RequestContextHeaders } from '@webpieces/core-context';
import {
    ClientConfig,
    ClientHttpFactory,
    NodeProxyClient,
} from '@webpieces/http-client-node';
import { SecureApi } from '@webpieces/client-server-api';
import { buildClientServerApiFactory, ClientServerApiFactoryOptions } from '../AppServerConfig';
import { TestAuthConfig } from './TestAuthConfig';

/**
 * Proves the CLIENT ↔ SERVER shared-secret symmetry over REAL HTTP:
 *  - the http client ATTACHES the value from its bound {@link Secrets} as `Authorization: Webpieces <secret>`,
 *  - the server ACCEPTS EITHER of the two {@link SharedSecrets} it holds for the key (rotation).
 * No process.env is read on either side — the secrets are literals bound per-test, so this runs
 * in parallel with everything else. (TestAuthConfig binds INTERNAL_API_SECRET →
 * SharedSecrets('some-test-key','some-test-key-rotating').)
 *
 * Every call runs inside RequestContext.run(...) because a server-side client reads the magic
 * context from the RequestContext and refuses to send without one — see RequestContextHeaders.
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

/** An http client for SecureApi whose bound Secrets sends `value` for the INTERNAL_API_SECRET key. */
function clientSending(value: string): SecureApi {
    // In prod the container supplies the provider (bindFrameworkProvider) and there is ONE factory
    // per service. Here each distinct secret needs its own NodeProxyClient, so we hand the provider
    // the resolve-lambda directly — the same seam, minus the container. mintIdToken is no longer
    // injected: NodeProxyClient calls gcp-identity directly.
    const secrets = new Secrets({ INTERNAL_API_SECRET: value });
    // RequestContextHeaders reads HeaderRegistry in its constructor, so build it here (after the
    // server started and configured the registry), never at module scope.
    const provider = new Provider(() => new NodeProxyClient(new RequestContextHeaders(), secrets));
    const factory = new ClientHttpFactory(provider);
    return factory.createClient(SecureApi, new ClientConfig('client-server', `http://localhost:${PORT}`));
}

describe('shared-secret over HTTP: client sends from Secrets, server accepts either', () => {
    it('client sending secret1 is accepted (200)', async () => {
        await RequestContext.run(async () => {
            const res = await clientSending('some-test-key').internalOp({});
            expect(res.ok).toBe(true);
        });
    });

    it('client sending secret2 (the rotating value) is ALSO accepted — zero-downtime rotation', async () => {
        await RequestContext.run(async () => {
            const res = await clientSending('some-test-key-rotating').internalOp({});
            expect(res.ok).toBe(true);
        });
    });

    it('client sending a wrong secret is rejected', async () => {
        await RequestContext.run(async () => {
            await expect(clientSending('not-the-secret').internalOp({})).rejects.toThrow();
        });
    });

    it('refuses to send outside a RequestContext — a call with no trace is a bug, not a default', async () => {
        await expect(clientSending('some-test-key').internalOp({}))
            .rejects.toThrow(/No active RequestContext/);
    });
});
