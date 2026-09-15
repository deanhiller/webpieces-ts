import 'reflect-metadata';
import express from 'express';
import type { Server as HttpServer } from 'http';
import { ContainerModule, ContainerModuleLoadOptions } from 'inversify';
import {
    ApiPath,
    ClientRegistry,
    ContextKey,
    Endpoint,
    HeaderRegistry,
    HttpHeader,
    HttpResponseDto,
    HttpResponseStatus,
    PathParam,
    QueryParam,
    Rpc,
    WpAuthJwt,
    WpAuthPublic,
} from '@webpieces/core-util';
import {
    AuthenticatedCaller,
    JWT_HOOK,
    JwtHook,
    MintedJwt,
    WebpiecesRouter,
    WebpiecesRouterFactory,
} from '@webpieces/http-routing';
import { HttpRequest, RequestContext, RequestContextHeaders } from '@webpieces/core-context';
import { WebpiecesExpressRouter } from '@webpieces/http-server';
import {
    ClientConfig as NodeClientConfig,
    ClientHttpFactory,
    DnsAddressResolver,
    NodeProxyClient,
} from '@webpieces/http-client-node';
import {
    ClientConfig as BrowserClientConfig,
    ClientHttpBrowserFactory,
    MutableContextStore,
} from '@webpieces/http-client-browser';
import { GcpOidc } from '@webpieces/gcp-identity';
import { Provider } from '@webpieces/core-context';

const PORT = 18325;
const AUTHORIZATION = ContextKey.untrusted<string>(
    'typedHttpTestAuthorization',
    'authorization',
    true,
);

class LookupResponse {
    constructor(
        public readonly owner: string,
        public readonly item: number,
        public readonly includeArchived: boolean | undefined,
        public readonly tags: string[] | undefined,
        public readonly nestedContextActive: boolean,
    ) {}
}

class RegisterRequest {
    constructor(public readonly client_name: string) {}
}

class TokenRequest {
    constructor(
        public readonly code: string,
        public readonly code_verifier: string,
        public readonly scope?: string[],
    ) {}
}

@Rpc()
@ApiPath('/typed/context')
abstract class ContextProbeApi {
    @WpAuthPublic('Internal context test endpoint')
    @Endpoint('/active', 'rpc', { httpMethod: 'GET' })
    // webpieces-disable no-unmanaged-exceptions -- contract stub
    active(): Promise<object> {
        throw new Error('contract only');
    }
}

@Rpc()
@ApiPath('/typed')
abstract class TypedTransportApi {
    @WpAuthPublic('Public metadata lookup')
    @Endpoint('/lookup/{owner}/{item}', 'rpc', { httpMethod: 'GET' })
    // webpieces-disable no-unmanaged-exceptions -- contract stub
    lookup(
        @PathParam('owner') _owner: string,
        @PathParam('item') _item: number,
        @QueryParam('include_archived') _includeArchived?: boolean,
        @QueryParam('tag') _tags?: string[],
    ): Promise<LookupResponse> {
        throw new Error('contract only');
    }

    @WpAuthPublic('Dynamic client registration is public by OAuth protocol')
    @Endpoint('/register', 'rpc', { responseType: 'full' })
    // webpieces-disable no-unmanaged-exceptions -- contract stub
    register(_request: RegisterRequest): Promise<HttpResponseDto<object>> {
        throw new Error('contract only');
    }

    @WpAuthPublic('Authorization request validates signed protocol parameters')
    @Endpoint('/authorize', 'rpc', { httpMethod: 'GET', responseType: 'full' })
    // webpieces-disable no-unmanaged-exceptions -- contract stub
    authorize(@QueryParam('client_id') _clientId: string): Promise<HttpResponseDto<undefined>> {
        throw new Error('contract only');
    }

    @WpAuthPublic('Token exchange authenticates the one-time code and PKCE verifier')
    @Endpoint('/token', 'rpc', { formPost: true, responseType: 'full' })
    // webpieces-disable no-unmanaged-exceptions -- contract stub
    token(_request: TokenRequest): Promise<HttpResponseDto<object>> {
        throw new Error('contract only');
    }

    @WpAuthJwt({ allRolesAllowed: true })
    @Endpoint('/secure/{id}', 'rpc', { httpMethod: 'GET' })
    // webpieces-disable no-unmanaged-exceptions -- contract stub
    secure(@PathParam('id') _id: number): Promise<object> {
        throw new Error('contract only');
    }
}

class ContextProbeController extends ContextProbeApi {
    override active(): Promise<object> {
        return Promise.resolve({ active: RequestContext.isActive() });
    }
}

class TypedTransportController extends TypedTransportApi {
    constructor(private readonly contextProbe: ContextProbeApi) {
        super();
    }

    override async lookup(
        owner: string,
        item: number,
        includeArchived?: boolean,
        tags?: string[],
    ): Promise<LookupResponse> {
        const nested = (await this.contextProbe.active()) as { active: boolean };
        return new LookupResponse(owner, item, includeArchived, tags, nested.active);
    }

    override register(request: RegisterRequest): Promise<HttpResponseDto<object>> {
        return Promise.resolve(
            new HttpResponseDto(
                new HttpResponseStatus(201, 'Created'),
                [
                    new HttpHeader('set-cookie', 'client=a; Path=/'),
                    new HttpHeader('set-cookie', 'session=b; Path=/'),
                ],
                { client_id: `registered-${request.client_name}` },
            ),
        );
    }

    override authorize(clientId: string): Promise<HttpResponseDto<undefined>> {
        return Promise.resolve(
            new HttpResponseDto(
                new HttpResponseStatus(302, 'Found'),
                [new HttpHeader('location', `/consent?client_id=${encodeURIComponent(clientId)}`)],
                undefined,
            ),
        );
    }

    override token(request: TokenRequest): Promise<HttpResponseDto<object>> {
        if (request.code !== 'valid-code' || request.code_verifier !== 'valid verifier') {
            return Promise.resolve(
                new HttpResponseDto(
                    new HttpResponseStatus(400, 'Bad Request'),
                    [new HttpHeader('content-type', 'application/json')],
                    { error: 'invalid_grant' },
                ),
            );
        }
        return Promise.resolve(
            new HttpResponseDto(new HttpResponseStatus(200, 'OK'), [], {
                access_token: 'issued',
                scope: request.scope,
            }),
        );
    }

    override secure(id: number): Promise<object> {
        return Promise.resolve({ id, contextActive: RequestContext.isActive() });
    }
}

class AllowJwtHook extends JwtHook<string> {
    override mint(token: string): Promise<MintedJwt> {
        return Promise.resolve(new MintedJwt(token, Math.floor(Date.now() / 1000) + 60));
    }

    override parseJwt(_token: string): Promise<AuthenticatedCaller> {
        return Promise.resolve(new AuthenticatedCaller('typed-http-user', ['user']));
    }
}

function nodeClient<T extends object>(api: abstract new (...args: never[]) => T): T {
    const provider = new Provider(
        () =>
            new NodeProxyClient(
                new RequestContextHeaders(),
                new GcpOidc(),
                new DnsAddressResolver(),
            ),
    );
    return new ClientHttpFactory(provider).createRpcClient(
        api,
        new NodeClientConfig('typed-http-test'),
    );
}

describe('real server + browser/node typed HTTP transports', () => {
    let server: HttpServer;
    let apiRouter: WebpiecesRouter;
    let browserStore: MutableContextStore;
    let browserClient: TypedTransportApi;
    let nodeTransportClient: TypedTransportApi;

    beforeAll(async () => {
        HeaderRegistry.configure([AUTHORIZATION], true);
        ClientRegistry.clear();
        ClientRegistry.addUrlMapping('typed-http-test', `http://localhost:${PORT}`);

        const contextController = new ContextProbeController();
        const transportController = new TypedTransportController(nodeClient(ContextProbeApi));
        const bindings = new ContainerModule((options: ContainerModuleLoadOptions) => {
            options.bind(ContextProbeController).toConstantValue(contextController);
            options.bind(TypedTransportController).toConstantValue(transportController);
            options.bind(JWT_HOOK).toConstantValue(new AllowJwtHook());
        });
        apiRouter = await WebpiecesRouterFactory.create({
            appBindings: [bindings],
        });
        apiRouter.addRoutes(ContextProbeApi, ContextProbeController);
        apiRouter.addRoutes(TypedTransportApi, TypedTransportController);
        server = await new WebpiecesExpressRouter(apiRouter).bindAndStartExpress(express(), PORT);

        browserStore = new MutableContextStore();
        browserClient = new ClientHttpBrowserFactory(browserStore).createRpcClient(
            TypedTransportApi,
            new BrowserClientConfig('typed-http-test'),
        );
        nodeTransportClient = nodeClient(TypedTransportApi);
    });

    afterAll(async () => {
        ClientRegistry.clear();
        await new Promise<void>((resolve: () => void) => server.close(() => resolve()));
    });

    it('browser GET reaches the normal server context/filter boundary and supports a nested Node RPC', async () => {
        const response = await browserClient.lookup('Dean / Київ', 7, true, ['red & blue', '✓']);

        expect(response).toEqual({
            owner: 'Dean / Київ',
            item: 7,
            includeArchived: true,
            tags: ['red & blue', '✓'],
            nestedContextActive: true,
        });
    });

    it('Node client supports 201 JSON, repeated headers, 302/no-body, and form exchange errors', async () => {
        await RequestContext.run(async () => {
            const registered = await nodeTransportClient.register(new RegisterRequest('demo'));
            expect(registered.status.code).toBe(201);
            expect(registered.body).toEqual({ client_id: 'registered-demo' });
            expect(
                registered.headers.filter((header: HttpHeader) => header.name === 'set-cookie'),
            ).toHaveLength(2);

            const redirect = await nodeTransportClient.authorize('client / one');
            expect(redirect.status.code).toBe(302);
            expect(redirect.body).toBeUndefined();
            expect(redirect.headers).toContainEqual(
                expect.objectContaining({
                    name: 'location',
                    value: '/consent?client_id=client%20%2F%20one',
                }),
            );

            const invalid = await nodeTransportClient.token(
                new TokenRequest('bad', 'wrong verifier'),
            );
            expect(invalid.status.code).toBe(400);
            expect(invalid.body).toEqual({ error: 'invalid_grant' });

            const valid = await nodeTransportClient.token(
                new TokenRequest('valid-code', 'valid verifier', ['read', 'write all']),
            );
            expect(valid.status.code).toBe(200);
            expect(valid.body).toEqual({
                access_token: 'issued',
                scope: ['read', 'write all'],
            });
        });
    });

    it('@WpAuthPublic still gets context, while @WpAuthJwt GET still enforces its credential', async () => {
        await expect(browserClient.secure(4)).rejects.toThrow();

        browserStore.set(AUTHORIZATION, 'Bearer test-token');
        await expect(browserClient.secure(4)).resolves.toEqual({ id: 4, contextActive: true });

        const malformed = await fetch(`http://localhost:${PORT}/typed/secure/not-a-number`, {
            headers: { authorization: 'Bearer test-token' },
        });
        expect(malformed.status).toBe(400);
    });

    it('createApiClient uses the same argument mapping/filter/controller path in-process', async () => {
        const featureClient = apiRouter.createApiClient<TypedTransportApi>(TypedTransportApi);
        const response = await RequestContext.run(async () => {
            RequestContext.setRequest(new HttpRequest('GET', '/feature-test', new Map()));
            return featureClient.lookup('feature/owner', 9, undefined, ['one', 'two']);
        });

        expect(response).toEqual({
            owner: 'feature/owner',
            item: 9,
            includeArchived: undefined,
            tags: ['one', 'two'],
            nestedContextActive: true,
        });
    });
});
