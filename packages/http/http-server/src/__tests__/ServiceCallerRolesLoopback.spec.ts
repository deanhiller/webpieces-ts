import 'reflect-metadata';
import { AddressInfo } from 'node:net';
import { Server } from 'node:http';
import express from 'express';
import { ContainerModule, ContainerModuleLoadOptions, inject, injectable } from 'inversify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
    ApiPath,
    ApiUnauthorizedError,
    AuthorizationType,
    ClientRegistry,
    Endpoint,
    HeaderRegistry,
    OidcAuthMethods,
    POST,
    READ,
    Rpc,
    RPC,
    WebpiecesCoreHeaders,
    WpAuth,
    WpAuthorization,
    jwt,
    oidcSameProject,
} from '@webpieces/core-util';
import { AuthenticatedCaller, AuthenticatedMachineIdentity, RequestContext } from '@webpieces/core-context';
import { GcpOidc } from '@webpieces/gcp-identity';
import {
    Binder,
    ContainerBinder,
    JWT_HOOK,
    JwtHook,
    MintedJwt,
    OIDC_HOOK,
    OidcHook,
    WebpiecesRouter,
    WebpiecesRouterFactory,
} from '@webpieces/http-routing';
import { WebpiecesExpressRouter } from '../WebpiecesExpressRouter';

/**
 * #1420, end to end over loopback: a service is a caller with ROLES and NO user id, and its roles
 * reach a `ROLES` endpoint THREE OIDC hops deep — while an intermediate service never contributes a
 * role of its own.
 *
 *   caller ──(oidc | jwt)──▶ edge ──oidc──▶ hop1 ──oidc──▶ hop2 ──oidc──▶ target
 *                            svc-edge        svc-hop1        svc-hop2      ROLES ['admin','order-bot']
 *                                                                          ALL_USERS
 *
 * Four real WebpiecesRouters on four real express listeners, real RPC clients forwarding trusted
 * context. Only the identity edges are stubs: Google's metadata server (each router mints its own
 * service account's token) and Google's token verification (the shared {@link ProjectOidcHook}).
 *
 * The OidcHook grants `order-bot` to the cron account and `admin` to EVERY relaying service account,
 * so a relay that wrongly contributed its own roles would admit a role-less user — the denial below
 * is what proves it does not.
 */

const OIDC_PREFIX = 'oidc:';
const CRON = 'cron@project.iam.gserviceaccount.com';
const PLAIN = 'plain@project.iam.gserviceaccount.com';
const EDGE = 'edge';
const HOP1 = 'hop1';
const HOP2 = 'hop2';
const TARGET = 'target';

class ActRequest {
    constructor(public readonly policy: string) {}
}

class ActResponse {
    constructor(
        public readonly userId: string,
        public readonly roles: string,
    ) {}
}

@Rpc()
@ApiPath('/target')
abstract class TargetApi {
    @Endpoint(POST, '/roles', READ, RPC)
    @WpAuth([oidcSameProject()])
    @WpAuthorization({ authType: AuthorizationType.ROLES, roles: ['admin', 'order-bot'] })
    // webpieces-disable no-unmanaged-exceptions -- abstract contract stub, never executed
    roles(_request: ActRequest): Promise<ActResponse> {
        throw new Error('contract only');
    }

    @Endpoint(POST, '/users', READ, RPC)
    @WpAuth([oidcSameProject()])
    @WpAuthorization({ authType: AuthorizationType.ALL_USERS })
    // webpieces-disable no-unmanaged-exceptions -- abstract contract stub, never executed
    users(_request: ActRequest): Promise<ActResponse> {
        throw new Error('contract only');
    }
}

@Rpc()
@ApiPath('/hop2')
abstract class Hop2Api {
    @Endpoint(POST, '/relay', READ, RPC)
    @WpAuth([oidcSameProject()])
    @WpAuthorization({ authType: AuthorizationType.USERS_OR_SERVICES })
    // webpieces-disable no-unmanaged-exceptions -- abstract contract stub, never executed
    relay(_request: ActRequest): Promise<ActResponse> {
        throw new Error('contract only');
    }
}

@Rpc()
@ApiPath('/hop1')
abstract class Hop1Api {
    @Endpoint(POST, '/relay', READ, RPC)
    @WpAuth([oidcSameProject()])
    @WpAuthorization({ authType: AuthorizationType.USERS_OR_SERVICES })
    // webpieces-disable no-unmanaged-exceptions -- abstract contract stub, never executed
    relay(_request: ActRequest): Promise<ActResponse> {
        throw new Error('contract only');
    }
}

/** The edge: a service originates over OIDC, a user over jwt(). */
@Rpc()
@ApiPath('/edge')
abstract class EdgeApi {
    @Endpoint(POST, '/service', READ, RPC)
    @WpAuth([oidcSameProject()])
    @WpAuthorization({ authType: AuthorizationType.USERS_OR_SERVICES })
    // webpieces-disable no-unmanaged-exceptions -- abstract contract stub, never executed
    service(_request: ActRequest): Promise<ActResponse> {
        throw new Error('contract only');
    }

    @Endpoint(POST, '/user', READ, RPC)
    @WpAuth([jwt()])
    @WpAuthorization({ authType: AuthorizationType.ALL_USERS })
    // webpieces-disable no-unmanaged-exceptions -- abstract contract stub, never executed
    user(_request: ActRequest): Promise<ActResponse> {
        throw new Error('contract only');
    }
}

let targetCalls = 0;

@injectable()
class TargetController extends TargetApi {
    override async roles(_request: ActRequest): Promise<ActResponse> {
        return this.seen();
    }

    override async users(_request: ActRequest): Promise<ActResponse> {
        return this.seen();
    }

    private seen(): ActResponse {
        targetCalls += 1;
        return new ActResponse(
            RequestContext.getTrusted(WebpiecesCoreHeaders.USER_ID) ?? 'none',
            RequestContext.getTrusted(WebpiecesCoreHeaders.USER_ROLES) ?? 'none',
        );
    }
}

@injectable()
class Hop2Controller extends Hop2Api {
    // webpieces-disable inject-annotation-not-needed-for-concrete-class -- abstract contract class is the token; esbuild elides design:paramtypes
    constructor(@inject(TargetApi) private readonly target: TargetApi) {
        super();
    }

    override async relay(request: ActRequest): Promise<ActResponse> {
        return request.policy === 'roles' ? this.target.roles(request) : this.target.users(request);
    }
}

@injectable()
class Hop1Controller extends Hop1Api {
    // webpieces-disable inject-annotation-not-needed-for-concrete-class -- abstract contract class is the token; esbuild elides design:paramtypes
    constructor(@inject(Hop2Api) private readonly hop2: Hop2Api) {
        super();
    }

    override async relay(request: ActRequest): Promise<ActResponse> {
        return this.hop2.relay(request);
    }
}

@injectable()
class EdgeController extends EdgeApi {
    // webpieces-disable inject-annotation-not-needed-for-concrete-class -- abstract contract class is the token; esbuild elides design:paramtypes
    constructor(@inject(Hop1Api) private readonly hop1: Hop1Api) {
        super();
    }

    override async service(request: ActRequest): Promise<ActResponse> {
        return this.hop1.relay(request);
    }

    override async user(request: ActRequest): Promise<ActResponse> {
        return this.hop1.relay(request);
    }
}

/** Google's metadata server, stubbed: this router's OWN service account token. */
class StubGcpOidc {
    constructor(private readonly account: string) {}

    mintIdToken(_audience: string): Promise<string> {
        return Promise.resolve(`${OIDC_PREFIX}${this.account}`);
    }
}

/** Google's token verification, stubbed, plus the app's service-account role grants. */
class ProjectOidcHook extends OidcHook {
    readonly rolesAsked: string[] = [];

    override async verifyOidc(token: string, _methods: OidcAuthMethods): Promise<AuthenticatedMachineIdentity> {
        if (!token.startsWith(OIDC_PREFIX)) throw new ApiUnauthorizedError('not a Google identity');
        return new AuthenticatedMachineIdentity('oidc', token.substring(OIDC_PREFIX.length));
    }

    override async originatingServiceRoles(identity: AuthenticatedMachineIdentity): Promise<readonly string[]> {
        this.rolesAsked.push(identity.identity);
        if (identity.identity === CRON) return ['order-bot'];
        if (identity.identity.startsWith('svc-')) return ['admin'];
        return [];
    }
}

/** The app's user JWT: `jwt-admin` holds `admin`, `jwt-alice` holds no role. */
class UserJwtHook extends JwtHook<string> {
    override async mint(_request: string): Promise<MintedJwt> {
        throw new Error('not used');
    }

    override async parseJwt(token: string): Promise<AuthenticatedCaller> {
        if (token === 'jwt-admin') return new AuthenticatedCaller('admin-user', ['admin']);
        if (token === 'jwt-alice') return new AuthenticatedCaller('alice', []);
        throw new ApiUnauthorizedError('unknown user token');
    }
}

function module(configure: (binder: Binder) => void): ContainerModule {
    return new ContainerModule((options: ContainerModuleLoadOptions) => configure(new ContainerBinder(options)));
}

function urlOf(server: Server): string {
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function close(server: Server): Promise<void> {
    server.closeAllConnections();
    await new Promise<void>((resolve: () => void) => server.close(() => resolve()));
}

describe('a service is a caller with roles and no user id, three OIDC hops deep (#1420)', () => {
    const oidcHook = new ProjectOidcHook();
    const servers: Server[] = [];
    let edgeUrl = '';

    async function serve(
        name: string,
        account: string,
        bind: (binder: Binder) => void,
        addRoutes: (router: WebpiecesRouter) => void,
    ): Promise<string> {
        const router = await WebpiecesRouterFactory.create({
            appBindings: [
                module((binder: Binder) => {
                    binder.bind(OIDC_HOOK).toConstantValue(oidcHook);
                    bind(binder);
                }),
            ],
            appOverrides: new ContainerModule(async (options: ContainerModuleLoadOptions) => {
                // webpieces-disable no-any-unknown -- test double for the metadata-server edge: only mintIdToken is reached
                (await options.rebind(GcpOidc)).toConstantValue(new StubGcpOidc(account) as unknown as GcpOidc);
            }),
        });
        addRoutes(router);
        const server = await new WebpiecesExpressRouter(router).bindAndStartExpress(express(), 0);
        servers.push(server);
        ClientRegistry.addUrlMapping(name, urlOf(server));
        return urlOf(server);
    }

    beforeAll(async () => {
        if (!HeaderRegistry.isConfigured()) HeaderRegistry.configure([], true);
        ClientRegistry.resetForTests();
        await serve(TARGET, 'svc-target', (binder: Binder) => binder.bind(TargetController).toSelf().inSingletonScope(),
            (router: WebpiecesRouter) => router.addRoutes(TargetApi, TargetController));
        await serve(HOP2, 'svc-hop2', (binder: Binder) => binder.createRpcClientAndBind(TargetApi, TARGET),
            (router: WebpiecesRouter) => router.addRoutes(Hop2Api, Hop2Controller));
        await serve(HOP1, 'svc-hop1', (binder: Binder) => binder.createRpcClientAndBind(Hop2Api, HOP2),
            (router: WebpiecesRouter) => router.addRoutes(Hop1Api, Hop1Controller));
        edgeUrl = await serve(EDGE, 'svc-edge', (binder: Binder) => {
            binder.bind(JWT_HOOK).toConstantValue(new UserJwtHook());
            binder.createRpcClientAndBind(Hop1Api, HOP1);
        }, (router: WebpiecesRouter) => router.addRoutes(EdgeApi, EdgeController));
    });

    afterAll(async () => {
        ClientRegistry.resetForTests();
        for (const server of servers) await close(server);
    });

    beforeEach(() => {
        targetCalls = 0;
        oidcHook.rolesAsked.length = 0;
    });

    async function asService(account: string, policy: string): Promise<globalThis.Response> {
        return post('/edge/service', `Bearer ${OIDC_PREFIX}${account}`, policy);
    }

    async function asUser(token: string, policy: string): Promise<globalThis.Response> {
        return post('/edge/user', `Bearer ${token}`, policy);
    }

    async function post(path: string, authorization: string, policy: string): Promise<globalThis.Response> {
        return fetch(`${edgeUrl}${path}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization },
            body: JSON.stringify(new ActRequest(policy)),
            signal: AbortSignal.timeout(5000),
        });
    }

    it('a service granted order-bot is authorized by ROLES three OIDC hops deep, with no user id', async () => {
        const response = await asService(CRON, 'roles');

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ userId: 'none', roles: JSON.stringify(['order-bot']) });
        expect(targetCalls).toBe(1);
        // Only the ORIGINATING service is asked for roles; every relay forwarded the cron's.
        expect(oidcHook.rolesAsked).toEqual([CRON]);
    });

    it('a service granted no role is denied by ROLES, even though every relay account holds admin', async () => {
        const response = await asService(PLAIN, 'roles');

        expect(response.status).not.toBe(200);
        expect(targetCalls).toBe(0);
    });

    it('a user with NO roles is denied by ROLES behind three role-bearing service hops', async () => {
        const response = await asUser('jwt-alice', 'roles');

        expect(response.status).not.toBe(200);
        expect(targetCalls).toBe(0);
        // A relay carrying a user's identity is never even asked for roles of its own.
        expect(oidcHook.rolesAsked).toEqual([]);
    });

    it('a user holding admin is authorized by ROLES three OIDC hops deep', async () => {
        const response = await asUser('jwt-admin', 'roles');

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ userId: 'admin-user', roles: JSON.stringify(['admin']) });
    });

    it('ALL_USERS denies a roles-bearing service caller with no user id, and admits a user', async () => {
        const denied = await asService(CRON, 'users');
        expect(denied.status).not.toBe(200);
        expect(targetCalls).toBe(0);

        const admitted = await asUser('jwt-alice', 'users');
        expect(admitted.status).toBe(200);
        expect(await admitted.json()).toEqual({ userId: 'alice', roles: '[]' });
    });
});
