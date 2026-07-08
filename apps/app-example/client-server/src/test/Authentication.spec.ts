import 'reflect-metadata';
import { ContainerModule, ContainerModuleLoadOptions } from 'inversify';
import jwt from 'jsonwebtoken';
import { AuthConfig } from '@webpieces/http-routing';
import { RequestContext, HttpRequest } from '@webpieces/core-context';
import { HttpUnauthorizedError, HttpForbiddenError, WebpiecesCoreHeaders, ContextKey } from '@webpieces/core-util';
import { mintIdToken } from '@webpieces/gcp-identity';
import { SecureApi } from '@webpieces/client-server-api';
import { TestAuthConfig, TEST_SHARED_SECRET, TEST_SHARED_SECRET_ROTATING } from './TestAuthConfig';
import { buildClientServerApiFactory, ClientServerApiFactoryOptions } from '../AppServerConfig';

/**
 * Authentication.spec.ts — proves the framework AuthFilter enforces every non-public AuthMode
 * end-to-end through the in-process client (createApiClient), for REAL:
 *  - shared-secret: the secret is bound STATE ('some-test-key'); a request carrying it passes, a
 *    wrong key 401s.
 *  - jwt: a REAL token signed with a test secret is parsed by CompanyAuthConfig; role-gating is
 *    enforced (admin ok; no token 401; wrong role 403).
 *  - oidc: a REAL dev OIDC token (gcp-identity off-GCP) verifies against the 'self' caller.
 *
 * The credential is delivered exactly as a transport would: RequestContext.setRequest(HttpRequest
 * carrying the auth header), then the api is called in-process — the SAME chain HTTP uses.
 */

const TEST_JWT_SECRET = 'test-jwt-secret-for-authentication-spec';

/** Build the app and return its SecureApi client, with the given container overrides. */
async function secureClient(overrides: ContainerModule): Promise<SecureApi> {
    const factory = await buildClientServerApiFactory(new ClientServerApiFactoryOptions(undefined, overrides));
    return factory.createApiClient<SecureApi>(SecureApi);
}

/**
 * Run a call with a single auth header published on the HttpRequest (as a transport would). Takes
 * the framework {@link ContextKey} so the wire header name comes from the SAME constant the server
 * (AuthFilter) reads — the test never hardcodes 'x-webpieces-shared-secret' / 'authorization'.
 */
async function withAuthHeader<T>(key: ContextKey, value: string, fn: () => Promise<T>): Promise<T> {
    const headerName = key.httpHeader ?? key.name;
    return RequestContext.run(async () => {
        const headers = new Map<string, string[]>([[headerName, [value]]]);
        RequestContext.setRequest(new HttpRequest('POST', '/secure', headers));
        return fn();
    });
}

describe('Authentication: shared-secret (bound state)', () => {
    // Bind a known secret VALUE — the whole point: a test passes the string in and validates it.
    const overrides = new ContainerModule(async (options: ContainerModuleLoadOptions) => {
        (await options.rebind(AuthConfig)).to(TestAuthConfig); // sharedSecrets: { INTERNAL_API_SECRET: TEST_SHARED_SECRET }
    });

    let api: SecureApi;
    beforeEach(async () => {
        api = await secureClient(overrides);
    });

    it('accepts the correct shared secret', async () => {
        const res = await withAuthHeader(WebpiecesCoreHeaders.SHARED_SECRET, TEST_SHARED_SECRET, () =>
            api.internalOp({ note: 'hi' }),
        );
        expect(res.ok).toBe(true);
    });

    it('accepts the rotating secret2 too (zero-downtime rotation window)', async () => {
        const res = await withAuthHeader(WebpiecesCoreHeaders.SHARED_SECRET, TEST_SHARED_SECRET_ROTATING, () =>
            api.internalOp({}),
        );
        expect(res.ok).toBe(true);
    });

    it('rejects a wrong shared secret (401)', async () => {
        await expect(
            withAuthHeader(WebpiecesCoreHeaders.SHARED_SECRET, 'WRONG-key', () => api.internalOp({})),
        ).rejects.toThrow(HttpUnauthorizedError);
    });

    it('rejects a missing shared secret (401)', async () => {
        await expect(RequestContext.run(() => api.internalOp({}))).rejects.toThrow(HttpUnauthorizedError);
    });
});

describe('Authentication: jwt (real signed token, role-gated)', () => {
    // Use the REAL CompanyAuthConfig (default binding) with a known signing secret.
    const overrides = new ContainerModule(() => Promise.resolve());
    let priorSecret: string | undefined;
    let api: SecureApi;

    beforeAll(() => {
        priorSecret = process.env['JWT_SECRET'];
        process.env['JWT_SECRET'] = TEST_JWT_SECRET;
    });
    afterAll(() => {
        if (priorSecret === undefined) delete process.env['JWT_SECRET'];
        else process.env['JWT_SECRET'] = priorSecret;
    });
    // beforeEach (not beforeAll) so the client is built AFTER JWT_SECRET is set above.
    beforeEach(async () => {
        api = await secureClient(overrides);
    });

    const sign = (payload: object): string => jwt.sign(payload, TEST_JWT_SECRET);

    it('accepts an admin JWT and stamps the userId into context', async () => {
        const token = sign({ sub: 'user-42', roles: ['admin'] });
        const res = await withAuthHeader(WebpiecesCoreHeaders.AUTHORIZATION, `Bearer ${token}`, () => api.adminOp({}));
        expect(res.ok).toBe(true);
        expect(res.userId).toBe('user-42'); // proves parseJwt → USER_ID context entry landed
    });

    it('allows ANY logged-in user on a no-role endpoint (@AuthJwt() with no roles)', async () => {
        const token = sign({ sub: 'user-99', roles: [] }); // authenticated, but zero roles
        const res = await withAuthHeader(WebpiecesCoreHeaders.AUTHORIZATION, `Bearer ${token}`, () => api.userOp({}));
        expect(res.ok).toBe(true);
        expect(res.userId).toBe('user-99');
    });

    it('@Auth({inOrg:true}): a logged-in user WITH an org claim passes (pluggable authZ)', async () => {
        const token = sign({ sub: 'user-11', orgId: 'org-1' });
        const res = await withAuthHeader(WebpiecesCoreHeaders.AUTHORIZATION, `Bearer ${token}`, () => api.orgOp({}));
        expect(res.ok).toBe(true);
    });

    it('@Auth({inOrg:true}): a logged-in user WITHOUT an org claim is denied (403)', async () => {
        const token = sign({ sub: 'user-12' }); // authenticated, but no orgId claim
        await expect(
            withAuthHeader(WebpiecesCoreHeaders.AUTHORIZATION, `Bearer ${token}`, () => api.orgOp({})),
        ).rejects.toThrow(HttpForbiddenError);
    });

    it('rejects a JWT missing the admin role (403)', async () => {
        const token = sign({ sub: 'user-7', roles: ['viewer'] });
        await expect(
            withAuthHeader(WebpiecesCoreHeaders.AUTHORIZATION, `Bearer ${token}`, () => api.adminOp({})),
        ).rejects.toThrow(HttpForbiddenError);
    });

    it('rejects a call with no token (401)', async () => {
        await expect(RequestContext.run(() => api.adminOp({}))).rejects.toThrow(HttpUnauthorizedError);
    });
});

describe('Authentication: oidc (real dev token, caller = self)', () => {
    const overrides = new ContainerModule(() => Promise.resolve()); // real CompanyAuthConfig → gcp-identity

    let api: SecureApi;
    beforeEach(async () => {
        api = await secureClient(overrides);
    });

    it('accepts a dev OIDC token minted for this service (self)', async () => {
        // Off-GCP, mintIdToken produces a dev token whose email is the runtime SA; @AuthOidc() = 'self'
        // resolves to that same SA, so verifyOidcFromCallers accepts it — real mint↔verify, no mocking.
        const token = await mintIdToken('http://localhost');
        const res = await withAuthHeader(WebpiecesCoreHeaders.AUTHORIZATION, `Bearer ${token}`, () => api.serviceOp({}));
        expect(res.ok).toBe(true);
    });

    it('rejects a call with no OIDC token (401)', async () => {
        await expect(RequestContext.run(() => api.serviceOp({}))).rejects.toThrow(HttpUnauthorizedError);
    });
});
