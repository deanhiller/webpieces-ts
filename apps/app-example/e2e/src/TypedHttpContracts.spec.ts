import { ClientRole, WpAuthorization, AuthorizationType, WpAuth, jwt as jwtAuth } from '@webpieces/core-util';
import 'reflect-metadata';
import express from 'express';
import type { Server as HttpServer } from 'http';
import { ContainerModule, ContainerModuleLoadOptions } from 'inversify';
import { ApiPath, ClientRegistry, ContextKey, Endpoint, HeaderRegistry, HttpHeader, HttpResponseDto, HttpResponseStatus, PathParam, QueryParam, Rpc, WpAuthPublic, GET, POST, PUT, PATCH, DELETE, NONE, READ, RPC, WRITE, WRITE_IDEMPOTENT, EXTERNAL_OUTBOUND, CLOUDTASKS, CRON, PubSub, ExternalContextKeys, WebpiecesCoreHeaders, QueryParams, QueryString } from '@webpieces/core-util';
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
import { GcpOidc } from '@webpieces/gcp-identity';
import { Provider } from '@webpieces/core-context';

const PORT = 18325;
const VENDOR_PORT = 18326;
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

class RenameRequest {
    constructor(public readonly name: string) {}
}

class ItemResponse {
    constructor(
        public readonly verb: string,
        public readonly id: string,
        public readonly name: string | undefined,
        public readonly reason: string | undefined,
    ) {}
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
    @WpAuthorization({ authType: AuthorizationType.ANONYMOUS, reason: 'Internal context test endpoint' })
    @Endpoint(GET, '/active', READ, RPC)
    // webpieces-disable no-unmanaged-exceptions -- contract stub
    active(): Promise<object> {
        throw new Error('contract only');
    }
}

@Rpc()
@ApiPath('/typed')
abstract class TypedTransportApi {
    @WpAuthPublic('Public metadata lookup')
    @WpAuthorization({ authType: AuthorizationType.ANONYMOUS, reason: 'Public metadata lookup' })
    @Endpoint(GET, '/lookup/{owner}/{item}', READ, RPC)
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
    @WpAuthorization({ authType: AuthorizationType.ANONYMOUS, reason: 'Dynamic client registration is public by OAuth protocol' })
    @Endpoint(POST, '/register', WRITE, RPC, { responseType: 'full' })
    // webpieces-disable no-unmanaged-exceptions -- contract stub
    register(_request: RegisterRequest): Promise<HttpResponseDto<object>> {
        throw new Error('contract only');
    }

    @WpAuthPublic('Authorization request validates signed protocol parameters')
    @WpAuthorization({ authType: AuthorizationType.ANONYMOUS, reason: 'Authorization request validates signed protocol parameters' })
    @Endpoint(GET, '/authorize', READ, RPC, { responseType: 'full' })
    // webpieces-disable no-unmanaged-exceptions -- contract stub
    authorize(@QueryParam('client_id') _clientId: string): Promise<HttpResponseDto<undefined>> {
        throw new Error('contract only');
    }

    @WpAuthPublic('Token exchange authenticates the one-time code and PKCE verifier')
    @WpAuthorization({ authType: AuthorizationType.ANONYMOUS, reason: 'Token exchange authenticates the one-time code and PKCE verifier' })
    @Endpoint(POST, '/token', WRITE, RPC, { formPost: true, responseType: 'full' })
    // webpieces-disable no-unmanaged-exceptions -- contract stub
    token(_request: TokenRequest): Promise<HttpResponseDto<object>> {
        throw new Error('contract only');
    }

    @WpAuth([jwtAuth()])
    @WpAuthorization({ authType: AuthorizationType.ALL_USERS })
    @Endpoint(GET, '/secure/{id}', READ, RPC)
    // webpieces-disable no-unmanaged-exceptions -- contract stub
    secure(@PathParam('id') _id: number): Promise<object> {
        throw new Error('contract only');
    }

    @WpAuthPublic('Verb round-trip fixture')
    @WpAuthorization({ authType: AuthorizationType.ANONYMOUS, reason: 'Verb round-trip fixture' })
    @Endpoint(PUT, '/items/{id}', WRITE_IDEMPOTENT, RPC)
    // webpieces-disable no-unmanaged-exceptions -- contract stub
    replace(@PathParam('id') _id: string, _request: RenameRequest): Promise<ItemResponse> {
        throw new Error('contract only');
    }

    @WpAuthPublic('Verb round-trip fixture')
    @WpAuthorization({ authType: AuthorizationType.ANONYMOUS, reason: 'Verb round-trip fixture' })
    @Endpoint(PATCH, '/items/{id}', WRITE, RPC)
    // webpieces-disable no-unmanaged-exceptions -- contract stub
    rename(@PathParam('id') _id: string, _request: RenameRequest): Promise<ItemResponse> {
        throw new Error('contract only');
    }

    @WpAuthPublic('Verb round-trip fixture')
    @WpAuthorization({ authType: AuthorizationType.ANONYMOUS, reason: 'Verb round-trip fixture' })
    @Endpoint(DELETE, '/items/{id}', WRITE_IDEMPOTENT, RPC)
    // webpieces-disable no-unmanaged-exceptions -- contract stub
    remove(@PathParam('id') _id: string, @QueryParam('reason') _reason?: string): Promise<ItemResponse> {
        throw new Error('contract only');
    }

    @WpAuthPublic('Void round-trip fixture')
    @WpAuthorization({ authType: AuthorizationType.ANONYMOUS, reason: 'Void round-trip fixture' })
    @Endpoint(PUT, '/touch/{id}', WRITE_IDEMPOTENT, RPC, { responseBody: NONE })
    // webpieces-disable no-unmanaged-exceptions -- contract stub
    touch(@PathParam('id') _id: string): Promise<void> {
        throw new Error('contract only');
    }
}

const VENDOR_MERCHANT = ContextKey.untrusted<string>('typedHttpVendorMerchant', 'x-vendor-merchant', true);

class EchoedHeaders {
    constructor(public readonly headers: Record<string, string>) {}
}

/** An outside system's API: only the listed context keys may reach it. */
@ApiPath('/vendor')
@ExternalContextKeys(WebpiecesCoreHeaders.REQUEST_ID)
abstract class EchoVendorApi {
    @WpAuthPublic('Outbound fixture')
    @WpAuthorization({ authType: AuthorizationType.ANONYMOUS, reason: 'Outbound fixture' })
    @Endpoint(GET, '/echo', READ, EXTERNAL_OUTBOUND)
    // webpieces-disable no-unmanaged-exceptions -- contract stub
    echo(): Promise<EchoedHeaders> {
        throw new Error('contract only');
    }

    @WpAuthPublic('Outbound fixture')
    @WpAuthorization({ authType: AuthorizationType.ANONYMOUS, reason: 'Outbound fixture' })
    @Endpoint(GET, '/echo-merchant', READ, EXTERNAL_OUTBOUND)
    @ExternalContextKeys(VENDOR_MERCHANT)
    // webpieces-disable no-unmanaged-exceptions -- contract stub
    echoMerchant(): Promise<EchoedHeaders> {
        throw new Error('contract only');
    }

    @WpAuthPublic('Outbound fixture')
    @WpAuthorization({ authType: AuthorizationType.ANONYMOUS, reason: 'Outbound fixture' })
    @Endpoint(GET, '/search/{shop}', READ, EXTERNAL_OUTBOUND)
    // webpieces-disable no-unmanaged-exceptions -- contract stub
    search(@PathParam('shop') _shop: string, @QueryString() _query: QueryParams): Promise<EchoedQuery> {
        throw new Error('contract only');
    }
}

class EchoedQuery {
    constructor(public readonly url: string) {}
}

/** A foreign server whose void routes answer an empty 200, `{}`, or an undocumented body. */
@Rpc()
@ApiPath('/vendor')
abstract class VoidVendorApi {
    @WpAuthPublic('Void tolerance fixture')
    @WpAuthorization({ authType: AuthorizationType.ANONYMOUS, reason: 'Void tolerance fixture' })
    @Endpoint(POST, '/empty', WRITE, RPC, { responseBody: NONE })
    // webpieces-disable no-unmanaged-exceptions -- contract stub
    empty(): Promise<void> {
        throw new Error('contract only');
    }

    @WpAuthPublic('Void tolerance fixture')
    @WpAuthorization({ authType: AuthorizationType.ANONYMOUS, reason: 'Void tolerance fixture' })
    @Endpoint(POST, '/object', WRITE, RPC, { responseBody: NONE })
    // webpieces-disable no-unmanaged-exceptions -- contract stub
    object(): Promise<void> {
        throw new Error('contract only');
    }

    @WpAuthPublic('Void tolerance fixture')
    @WpAuthorization({ authType: AuthorizationType.ANONYMOUS, reason: 'Void tolerance fixture' })
    @Endpoint(POST, '/data', WRITE, RPC, { responseBody: NONE })
    // webpieces-disable no-unmanaged-exceptions -- contract stub
    data(): Promise<void> {
        throw new Error('contract only');
    }
}

/** CLOUDTASKS / CRON endpoints have no response body BY KIND (#1348): no responseBody option. */
@PubSub()
@ApiPath('/typed/trigger')
abstract class TriggerApi {
    @WpAuthPublic('Trigger fixture')
    @WpAuthorization({ authType: AuthorizationType.ANONYMOUS, reason: 'Trigger fixture' })
    @Endpoint(POST, '/run', WRITE, CLOUDTASKS)
    // webpieces-disable no-unmanaged-exceptions -- contract stub
    run(_request: RenameRequest): Promise<void> {
        throw new Error('contract only');
    }

    @WpAuthPublic('Trigger fixture')
    @WpAuthorization({ authType: AuthorizationType.ANONYMOUS, reason: 'Trigger fixture' })
    @Endpoint(POST, '/tick', WRITE, CRON)
    // webpieces-disable no-unmanaged-exceptions -- contract stub
    tick(_request: RenameRequest): Promise<void> {
        throw new Error('contract only');
    }
}

/** A vendor acknowledging our outbound calls with any 2xx (#1348): no responseBody option. */
@ApiPath('/ack')
abstract class AckVendorApi {
    @WpAuthPublic('Outbound ack fixture')
    @WpAuthorization({ authType: AuthorizationType.ANONYMOUS, reason: 'Outbound ack fixture' })
    @Endpoint(POST, '/{shape}', WRITE, EXTERNAL_OUTBOUND)
    // webpieces-disable no-unmanaged-exceptions -- contract stub
    notify(@PathParam('shape') _shape: string): Promise<void> {
        throw new Error('contract only');
    }
}

class TriggerController extends TriggerApi {
    readonly delivered: string[] = [];

    override run(request: RenameRequest): Promise<void> {
        this.delivered.push(`run:${request.name}`);
        return Promise.resolve();
    }

    override tick(request: RenameRequest): Promise<void> {
        this.delivered.push(`tick:${request.name}`);
        return Promise.resolve();
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

    override replace(id: string, request: RenameRequest): Promise<ItemResponse> {
        return Promise.resolve(new ItemResponse('PUT', id, request.name, undefined));
    }

    override rename(id: string, request: RenameRequest): Promise<ItemResponse> {
        return Promise.resolve(new ItemResponse('PATCH', id, request.name, undefined));
    }

    override remove(id: string, reason?: string): Promise<ItemResponse> {
        return Promise.resolve(new ItemResponse('DELETE', id, undefined, reason));
    }

    readonly touched: string[] = [];

    override touch(id: string): Promise<void> {
        this.touched.push(id);
        return Promise.resolve();
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

function nodeClient<T extends object>(
    api: abstract new (...args: never[]) => T,
    service: string = 'typed-http-test',
): T {
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
        new NodeClientConfig(service, ClientRole.SERVER),
    );
}

describe('real server + node typed HTTP transport', () => {
    let server: HttpServer;
    let vendorServer: HttpServer;
    let apiRouter: WebpiecesRouter;
    let nodeTransportClient: TypedTransportApi;
    let transportController: TypedTransportController;
    const triggerController = new TriggerController();

    beforeAll(async () => {
        HeaderRegistry.configure([AUTHORIZATION, VENDOR_MERCHANT], true);
        ClientRegistry.resetForTests();
        ClientRegistry.addUrlMapping('typed-http-test', `http://localhost:${PORT}`);
        ClientRegistry.addUrlMapping('void-vendor', `http://localhost:${VENDOR_PORT}`);
        const vendor = express();
        vendor.post('/vendor/empty', (_req: express.Request, res: express.Response) => res.status(200).end());
        vendor.post('/vendor/object', (_req: express.Request, res: express.Response) => res.status(200).json({}));
        vendor.post('/vendor/data', (_req: express.Request, res: express.Response) => res.status(200).json({ id: 'x' }));
        const echo = (req: express.Request, res: express.Response): void => {
            const headers: Record<string, string> = {};
            for (const [name, value] of Object.entries(req.headers)) {
                if (name.startsWith('x-')) headers[name] = String(value);
            }
            // A vendor answering with OUR header names must not write into our context.
            res.setHeader('x-request-id', 'vendor-minted-id');
            res.status(200).json({ headers });
        };
        vendor.post('/ack/no-content', (_req: express.Request, res: express.Response) => res.status(204).end());
        vendor.post('/ack/empty', (_req: express.Request, res: express.Response) => res.status(200).end());
        vendor.post('/ack/accepted', (_req: express.Request, res: express.Response) => res.status(202).json({ id: 'x' }));
        vendor.post('/ack/text', (_req: express.Request, res: express.Response) => res.status(200).type('text/plain').send('OK'));
        vendor.post('/ack/mislabelled', (_req: express.Request, res: express.Response) => res.status(200).type('application/json').send('OK'));
        vendor.get('/vendor/echo', echo);
        vendor.get('/vendor/echo-merchant', echo);
        vendor.get('/vendor/search/:shop', (req: express.Request, res: express.Response) => res.status(200).json({ url: req.originalUrl }));
        vendorServer = await new Promise<HttpServer>((resolve: (s: HttpServer) => void) => {
            const listening = vendor.listen(VENDOR_PORT, () => resolve(listening));
        });

        const contextController = new ContextProbeController();
        transportController = new TypedTransportController(nodeClient(ContextProbeApi));
        const bindings = new ContainerModule((options: ContainerModuleLoadOptions) => {
            options.bind(ContextProbeController).toConstantValue(contextController);
            options.bind(TypedTransportController).toConstantValue(transportController);
            options.bind(TriggerController).toConstantValue(triggerController);
            options.bind(JWT_HOOK).toConstantValue(new AllowJwtHook());
        });
        apiRouter = await WebpiecesRouterFactory.create({
            appBindings: [bindings],
        });
        apiRouter.addRoutes(ContextProbeApi, ContextProbeController);
        apiRouter.addRoutes(TypedTransportApi, TypedTransportController);
        apiRouter.addRoutes(TriggerApi, TriggerController);
        server = await new WebpiecesExpressRouter(apiRouter).bindAndStartExpress(express(), PORT);

        nodeTransportClient = nodeClient(TypedTransportApi);
    });

    afterAll(async () => {
        ClientRegistry.resetForTests();
        await new Promise<void>((resolve: () => void) => server.close(() => resolve()));
        await new Promise<void>((resolve: () => void) => vendorServer.close(() => resolve()));
    });

    it('GET reaches the normal server context/filter boundary and supports a nested Node RPC', async () => {
        const response = await RequestContext.run(() =>
            nodeTransportClient.lookup('Dean / Київ', 7, true, ['red & blue', '✓']),
        );

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
        await expect(RequestContext.run(() => nodeTransportClient.secure(4))).rejects.toThrow();

        const authorized = await RequestContext.run(() => {
            RequestContext.putUntrusted(AUTHORIZATION, 'Bearer test-token');
            return nodeTransportClient.secure(4);
        });
        expect(authorized).toEqual({ id: 4, contextActive: true });

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

    it('PUT, PATCH and DELETE round-trip node client -> wire -> server -> controller', async () => {
        await RequestContext.run(async () => {
            expect(await nodeTransportClient.replace('a/b', new RenameRequest('one'))).toEqual(
                { verb: 'PUT', id: 'a/b', name: 'one' },
            );
            expect(await nodeTransportClient.rename('a/b', new RenameRequest('two'))).toEqual(
                { verb: 'PATCH', id: 'a/b', name: 'two' },
            );
            expect(await nodeTransportClient.remove('a/b', 'stale')).toEqual({
                verb: 'DELETE',
                id: 'a/b',
                reason: 'stale',
            });
        });
    });

    it('PUT, PATCH and DELETE map identically through the in-process client', async () => {
        const featureClient = apiRouter.createApiClient<TypedTransportApi>(TypedTransportApi);
        await RequestContext.run(async () => {
            RequestContext.setRequest(new HttpRequest('PUT', '/feature-test', new Map()));
            expect(await featureClient.replace('x', new RenameRequest('one'))).toEqual(
                new ItemResponse('PUT', 'x', 'one', undefined),
            );
            expect(await featureClient.rename('x', new RenameRequest('two'))).toEqual(
                new ItemResponse('PATCH', 'x', 'two', undefined),
            );
            expect(await featureClient.remove('x', 'gone')).toEqual(
                new ItemResponse('DELETE', 'x', undefined, 'gone'),
            );
        });
    });

    it('a void route answers 204 with 0 bytes and every client resolves undefined', async () => {
        await RequestContext.run(async () => {
            expect(await nodeTransportClient.touch('one')).toBeUndefined();
        });
        const raw = await fetch(`http://localhost:${PORT}/typed/touch/two`, { method: 'PUT' });
        expect(raw.status).toBe(204);
        expect(raw.headers.get('content-type')).toBeNull();
        expect(await raw.text()).toBe('');

        const featureClient = apiRouter.createApiClient<TypedTransportApi>(TypedTransportApi);
        const inProcess = await RequestContext.run(async () => {
            RequestContext.setRequest(new HttpRequest('PUT', '/feature-test', new Map()));
            return featureClient.touch('three');
        });
        expect(inProcess).toBeUndefined();
        expect(transportController.touched).toEqual(['one', 'two', 'three']);
    });

    it('CLOUDTASKS and CRON answer 204 with 0 bytes by KIND, and the in-process client resolves undefined', async () => {
        for (const path of ['run', 'tick']) {
            const raw = await fetch(`http://localhost:${PORT}/typed/trigger/${path}`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ name: 'wire' }),
            });
            expect(raw.status).toBe(204);
            expect(raw.headers.get('content-type')).toBeNull();
            expect(await raw.text()).toBe('');
        }

        const inProcess = apiRouter.createApiClient<TriggerApi>(TriggerApi);
        const results = await RequestContext.run(async () => {
            RequestContext.setRequest(new HttpRequest('POST', '/feature-test', new Map()));
            return [await inProcess.run(new RenameRequest('local')), await inProcess.tick(new RenameRequest('local'))];
        });
        expect(results).toEqual([undefined, undefined]);
        expect(triggerController.delivered).toEqual(['run:wire', 'tick:wire', 'run:local', 'tick:local']);
    });

    it('an EXTERNAL_OUTBOUND void call accepts ANY 2xx: 204/empty/text -> undefined, JSON -> parsed, never throws', async () => {
        const vendor = nodeClient(AckVendorApi, 'void-vendor');
        const results = await RequestContext.run(async () => {
            const seen: unknown[] = [];
            for (const shape of ['no-content', 'empty', 'accepted', 'text', 'mislabelled']) {
                seen.push(await vendor.notify(shape));
            }
            return seen;
        });
        expect(results).toEqual([undefined, undefined, { id: 'x' }, undefined, undefined]);
    });

    it('a void route on a foreign server accepts an empty 200, {} or an undocumented body', async () => {
        const vendor = nodeClient(VoidVendorApi, 'void-vendor');
        await RequestContext.run(async () => {
            expect(await vendor.empty()).toBeUndefined();
            expect(await vendor.object()).toBeUndefined();
            expect(await vendor.data()).toBeUndefined();
        });
    });

    it('an EXTERNAL_OUTBOUND client sends ONLY its listed context keys and believes no response header', async () => {
        const vendor = nodeClient(EchoVendorApi, 'void-vendor');
        await RequestContext.run(async () => {
            RequestContext.putUntrusted(WebpiecesCoreHeaders.REQUEST_ID, 'our-request-id');
            RequestContext.putUntrusted(AUTHORIZATION, 'Bearer never-to-a-vendor');
            RequestContext.putUntrusted(VENDOR_MERCHANT, 'merchant-1');

            const echoed = await vendor.echo();
            expect(echoed.headers).toEqual({ 'x-request-id': 'our-request-id' });

            const withMerchant = await vendor.echoMerchant();
            expect(withMerchant.headers).toEqual({
                'x-request-id': 'our-request-id',
                'x-vendor-merchant': 'merchant-1',
            });
            expect(RequestContext.getAny(WebpiecesCoreHeaders.REQUEST_ID)).toBe('our-request-id');
        });
    });

    it('an EXTERNAL_OUTBOUND client throws before any I/O when a listed key has no value', async () => {
        const vendor = nodeClient(EchoVendorApi, 'void-vendor');
        await RequestContext.run(async () => {
            RequestContext.putUntrusted(WebpiecesCoreHeaders.REQUEST_ID, 'our-request-id');
            await expect(vendor.echoMerchant()).rejects.toThrow(
                "Context key 'typedHttpVendorMerchant' (header x-vendor-merchant) is listed in @ExternalContextKeys",
            );
        });
    });

    it('no server may addRoutes an EXTERNAL_OUTBOUND contract', () => {
        class EchoVendorController extends EchoVendorApi {
            override echo(): Promise<EchoedHeaders> {
                return Promise.resolve(new EchoedHeaders({}));
            }

            override echoMerchant(): Promise<EchoedHeaders> {
                return Promise.resolve(new EchoedHeaders({}));
            }
        }
        expect(() => apiRouter.addRoutes(EchoVendorApi, EchoVendorController)).toThrow(
            'EchoVendorApi is an EXTERNAL_OUTBOUND contract',
        );
    });

    it('an EXTERNAL_OUTBOUND @QueryString() sends the multimap as repeated keys, in order', async () => {
        const vendor = nodeClient(EchoVendorApi, 'void-vendor');
        const echoed = await RequestContext.run(() => {
            RequestContext.putUntrusted(WebpiecesCoreHeaders.REQUEST_ID, 'our-request-id');
            return vendor.search('s 1', new QueryParams().add('filter', 'a=b').add('filter', 'c').set('limit', 5));
        });
        expect(echoed.url).toBe('/vendor/search/s%201?filter=a%3Db&filter=c&limit=5');
    });
});
