import 'reflect-metadata';
import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import { ContainerModule, type ContainerModuleLoadOptions, injectable } from 'inversify';
import {
    ApiPath,
    AuthorizationType,
    Endpoint,
    HeaderRegistry,
    jwt,
    POST,
    READ,
    RPC,
    WpAuth,
    WpAuthorization,
    WebpiecesCoreHeaders,
} from '@webpieces/core-util';
import { AuthenticatedCaller, RequestContext } from '@webpieces/core-context';
import {
    JwtHook,
    JWT_HOOK,
    MintedJwt,
    LazyController,
    LazyImplementation,
    ApplicationImplementation,
    WebpiecesRouterFactory,
} from '@webpieces/http-routing';
import { WebpiecesExpressRouter } from '../WebpiecesExpressRouter';

class RequestDto {
    constructor(public readonly value: string) {}
}
class ResponseDto {
    constructor(
        public readonly value: string,
        public readonly user: string | undefined,
        public readonly count: number,
    ) {}
}
@ApiPath('/deferred')
abstract class AdminApi {
    @WpAuth([jwt()])
    @WpAuthorization({ authType: AuthorizationType.ROLES, roles: ['admin'] })
    @Endpoint(POST, '/read', READ, RPC)
    read(_request: RequestDto): Promise<ResponseDto> {
        throw new Error('contract');
    }
}
@injectable()
class AdminController extends AdminApi {
    private count = 0;
    override async read(request: RequestDto): Promise<ResponseDto> {
        return new ResponseDto(
            request.value,
            RequestContext.getTrusted(WebpiecesCoreHeaders.USER_ID),
            ++this.count,
        );
    }
}
/** Local fixture for the external credential-verification edge. */
class TestCredentials extends JwtHook<never> {
    override async mint(_request: never): Promise<MintedJwt> {
        throw new Error('not used');
    }
    override async parseJwt(token: string): Promise<AuthenticatedCaller> {
        return new AuthenticatedCaller(token, token.startsWith('admin') ? ['admin'] : []);
    }
}
class LoopbackApp {
    constructor(private readonly mode: 'isolated' | 'application') {}
    server?: Server;
    url = '';
    imports = 0;
    async boot(): Promise<void> {
        HeaderRegistry.configure([], true);
        const router = await WebpiecesRouterFactory.create({
            appBindings: [
                new ContainerModule((options: ContainerModuleLoadOptions) => {
                    options.bind(JWT_HOOK).toConstantValue(new TestCredentials());
                }),
            ],
        });
        router.addRoutes(
            AdminApi,
            new LazyController('AdminController', '**/AdminController.ts', 1000, async () => {
                this.imports++;
                return this.mode === 'application'
                    ? new ApplicationImplementation(AdminController)
                    : new LazyImplementation(AdminController, [], [], []);
            }),
        );
        const app = express();
        new WebpiecesExpressRouter(router).bindExpress(app);
        this.server = createServer(app);
        await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
        this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    }
    async request(token?: string): Promise<Response> {
        const headers = new Headers({ 'content-type': 'application/json' });
        if (token) headers.set('authorization', `Bearer ${token}`);
        return fetch(this.url + '/deferred/read', {
            method: 'POST',
            headers,
            body: JSON.stringify(new RequestDto('real HTTP')),
        });
    }
    async close(): Promise<void> {
        if (!this.server) return;
        this.server.closeAllConnections();
        await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    }
}

for (const mode of ['isolated', 'application'] as const) {
    describe(`lazy implementation through the actual Express transport (${mode})`, () => {
        const app = new LoopbackApp(mode);
        afterEach(async () => app.close());
        it('binds the route before import and initializes only after successful HTTP authorization', async () => {
            await app.boot();
            expect(app.imports).toBe(0);
            expect((await app.request()).status).toBe(401);
            expect((await app.request('reader')).status).toBe(403);
            expect(app.imports).toBe(0);
            const first = await app.request('admin-one');
            expect(first.status).toBe(200);
            expect(await first.json()).toEqual(new ResponseDto('real HTTP', 'admin-one', 1));
            const second = await app.request('admin-two');
            expect(second.status).toBe(200);
            expect(await second.json()).toEqual(new ResponseDto('real HTTP', 'admin-two', 2));
            expect(app.imports).toBe(1);
        });
    });
}
