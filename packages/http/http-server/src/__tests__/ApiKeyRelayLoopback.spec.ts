import 'reflect-metadata';
import { Server } from 'node:http';
import { AddressInfo } from 'node:net';
import express from 'express';
import { ContainerModule, ContainerModuleLoadOptions, injectable } from 'inversify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
    ApiPath, ApiType, ApiUnauthorizedError, AuthorizationType, ClientRegistry, ClientRole,
    ContextKey, Endpoint, EXTERNAL_CUSTOMER, Filter, HeaderRegistry, Logger, LoggerFactory,
    LogManager, POST, READ, RPC, Service, SVC_TO_SVC, WpAuth, WpAuthPublic,
    WpAuthorization, WebpiecesCoreHeaders, apiKey, sharedSecret,
} from '@webpieces/core-util';
import { AuthenticatedCaller, HttpRequest, RequestContext } from '@webpieces/core-context';
import { ClientConfig, ClientHttpFactory } from '@webpieces/http-client-node'; // eslint-disable-line @webpieces/enforce-architecture -- test-only real outbound client to inbound Express authentication proof (#1452)
import { ClientFilterDefinition, ClientRequest } from '@webpieces/http-client-core'; // eslint-disable-line @webpieces/enforce-architecture -- app-owned outbound credential filter exercised over real HTTP
import { API_KEY_HOOK, ApiKeyHook, AUTH_CONFIG, AuthConfig, SharedSecrets, WebpiecesRouterFactory } from '@webpieces/http-routing';
import { WebpiecesExpressRouter } from '../WebpiecesExpressRouter';

const KEY = ContextKey.untrusted<string>('relayFixtureKey', 'x-relay-fixture-key', true);
const HELD_KEY = 'synthetic-partner-secret-1452';
const statuses: number[] = [];
/** Observable application writes: authentication failures must never reach controller behavior. */
const persistedValues: string[] = [];
class Input { constructor(readonly value: string) {} }
class Output { constructor(readonly value: string, readonly keyPresent = false) {} }

@ApiType(EXTERNAL_CUSTOMER, SVC_TO_SVC)
@ApiPath('/partner')
abstract class PartnerApi {
    @Endpoint(POST, '/read', READ, RPC)
    @WpAuth([apiKey('relay-fixture', [{ in: 'header', key: KEY }])])
    @WpAuthorization({ authType: AuthorizationType.ALL_USERS })
    read(_input: Input): Promise<Output> { throw new Error('contract'); }

    @Endpoint(POST, '/mixed', READ, RPC)
    @WpAuth([sharedSecret('unavailable-fixture-secret'), apiKey('relay-fixture', [{ in: 'header', key: KEY }])])
    @WpAuthorization({ authType: AuthorizationType.ALL_USERS })
    mixed(_input: Input): Promise<Output> { throw new Error('contract'); }
}
@ApiPath('/unrelated')
abstract class UnrelatedApi {
    @Endpoint(POST, '/read', READ, RPC)
    @WpAuthPublic('Synthetic unrelated destination for credential isolation')
    @WpAuthorization({ authType: AuthorizationType.ANONYMOUS, reason: 'Synthetic credential isolation' })
    read(_input: Input): Promise<Output> { throw new Error('contract'); }
}
class PartnerCredentials extends ApiKeyHook {
    readonly seen: Array<string | undefined> = [];
    readonly authorization: Array<string | undefined> = [];
    override async verifyApiKey(regime: string, request: HttpRequest): Promise<AuthenticatedCaller> {
        const key = request.getHeader(KEY);
        this.seen.push(key);
        this.authorization.push(request.getHeader('authorization'));
        if (regime !== 'relay-fixture' || key !== HELD_KEY)
            throw new ApiUnauthorizedError('Invalid partner credential');
        return new AuthenticatedCaller('partner-fixture');
    }
}
/** App behavior on ONE client; the framework neither mints nor globally propagates the key. */
class PartnerCredentialFilter extends Filter<ClientRequest, Response> {
    constructor(private readonly key?: string, private readonly surface?: 'gui' | 'llm') { super(); }
    override async filter(request: ClientRequest, next: Service<ClientRequest, Response>): Promise<Response> {
        expect(request.route.authMeta?.methods[0].kind).toBe('apikey');
        if (this.key !== undefined) {
            expect(request.url).not.toContain(this.key);
            request.headers.set(KEY.httpHeader!, this.key);
        }
        if (this.surface) request.headers.set(WebpiecesCoreHeaders.SURFACE.httpHeader!, this.surface);
        const response = await next.invoke(request);
        statuses.push(response.status);
        return response;
    }
}
@injectable()
class PartnerController extends PartnerApi {
    override async read(input: Input): Promise<Output> {
        persistedValues.push(input.value);
        return new Output(input.value);
    }
    override async mixed(input: Input): Promise<Output> { return new Output(input.value); }
}
@injectable()
class UnrelatedController extends UnrelatedApi {
    override async read(input: Input): Promise<Output> {
        return new Output(input.value, RequestContext.getRequest()?.getHeader(KEY) !== undefined);
    }
}
class RecordedLogs implements LoggerFactory, Logger {
    readonly lines: string[] = [];
    getLogger(_name: string): Logger { return this; }
    trace(message: string): void { this.lines.push(message); }
    debug(message: string): void { this.lines.push(message); }
    info(message: string): void { this.lines.push(message); }
    warn(message: string): void { this.lines.push(message); }
    error(message: string): void { this.lines.push(message); }
}

describe('app-relayed API key through typed Node client and real Express auth (#1452)', () => {
    let server: Server;
    let unrelated: Server;
    let factory: ClientHttpFactory;
    let priorLogs: LoggerFactory;
    const credentials = new PartnerCredentials();
    const logs = new RecordedLogs();

    async function listen(partner: boolean): Promise<Server> {
        const router = await WebpiecesRouterFactory.create({ appBindings: [
            new ContainerModule((options: ContainerModuleLoadOptions) => {
                options.bind(API_KEY_HOOK).toConstantValue(credentials);
                options.bind(AUTH_CONFIG).toConstantValue(new AuthConfig({
                    'unavailable-fixture-secret': new SharedSecrets('server-only-secret', ''),
                }));
                options.bind(PartnerController).toSelf();
                options.bind(UnrelatedController).toSelf();
            }),
        ] });
        if (partner) router.addRoutes(PartnerApi, PartnerController);
        else router.addRoutes(UnrelatedApi, UnrelatedController);
        factory ??= router.getContainer().get(ClientHttpFactory);
        return new WebpiecesExpressRouter(router).bindAndStartExpress(express(), 0);
    }
    function url(listener: Server): string {
        return `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
    }
    function client(key?: string, surface?: 'gui' | 'llm'): PartnerApi {
        return factory.createRpcClient(PartnerApi, new ClientConfig('relay-partner', ClientRole.SERVER),
            [new ClientFilterDefinition(100, new PartnerCredentialFilter(key, surface))]);
    }
    beforeAll(async () => {
        HeaderRegistry.configure([], true);
        priorLogs = LogManager.getFactory();
        LogManager.setFactory(logs);
        ClientRegistry.resetForTests();
        server = await listen(true);
        unrelated = await listen(false);
        ClientRegistry.addUrlMapping('relay-partner', url(server));
        ClientRegistry.addUrlMapping('relay-unrelated', url(unrelated));
    });
    afterAll(async () => {
        for (const listener of [server, unrelated]) {
            listener?.closeAllConnections();
            if (listener) await new Promise<void>((resolve: () => void) => listener.close(() => resolve()));
        }
        ClientRegistry.resetForTests();
        LogManager.setFactory(priorLogs);
    });
    it('sends the app-supplied declared key to the real route', async () => {
        const result = await RequestContext.run(() => client(HELD_KEY).read(new Input('accepted')));
        expect(result).toEqual(new Output('accepted'));
        expect(credentials.seen.at(-1)).toBe(HELD_KEY);
        expect(JSON.stringify(result)).not.toContain(HELD_KEY);
        expect(logs.lines.join('\n')).not.toContain(HELD_KEY);
    });
    it.each([undefined, 'wrong-fixture-key'])('the server refuses missing/wrong key %s', async (key: string | undefined) => {
        const before = [...persistedValues];
        await expect(RequestContext.run(() => client(key).read(new Input('denied')))).rejects.toThrow();
        expect(persistedValues).toEqual(before);
        expect(credentials.seen.at(-1)).toBe(key);
        expect(credentials.authorization.at(-1)).toBeUndefined();
        expect(statuses.at(-1)).toBe(401);
        expect(logs.lines.join('\n')).not.toContain(HELD_KEY);
    });
    it.each(['gui', 'llm'] as const)('a relayed key cannot assert the %s caller surface', async (surface: 'gui' | 'llm') => {
        const before = [...persistedValues];
        await expect(RequestContext.run(() => client(HELD_KEY, surface).read(new Input('denied'))))
            .rejects.toThrow();
        expect(statuses.at(-1)).toBe(401);
        expect(persistedValues).toEqual(before);
    });
    it('selects an app-relayed alternative after an unsatisfiable first declaration', async () => {
        expect(await RequestContext.run(() => client(HELD_KEY).mixed(new Input('mixed'))))
            .toEqual(new Output('mixed'));
    });
    it('does not propagate the key to an unrelated client/destination in the same context', async () => {
        const ordinary = factory.createRpcClient(UnrelatedApi,
            new ClientConfig('relay-unrelated', ClientRole.SERVER));
        const result = await RequestContext.run(async () => {
            await client(HELD_KEY).read(new Input('partner'));
            return ordinary.read(new Input('unrelated'));
        });
        expect(result).toEqual(new Output('unrelated', false));
    });
});
