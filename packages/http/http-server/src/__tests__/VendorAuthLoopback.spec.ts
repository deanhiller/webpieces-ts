import 'reflect-metadata';
import { AddressInfo } from 'node:net';
import { Server } from 'node:http';
import express, { NextFunction, Request, Response as ExpressResponse } from 'express';
import { ContainerModule, ContainerModuleLoadOptions, inject, injectable } from 'inversify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
    ApiPath,
    ApiUnauthorizedError,
    AuthorizationType,
    ClientRegistry,
    ClientRole,
    ContextKey,
    ContextTuple,
    Endpoint,
    EXTERNAL_INBOUND,
    HeaderRegistry,
    OidcAuthMethods,
    POST,
    READ,
    Rpc,
    RPC,
    WRITE,
    WpAuth,
    WpAuthorization,
    oidcSameProject,
    vendorAuth,
} from '@webpieces/core-util';
import {
    AuthenticatedCaller,
    AuthenticatedMachineIdentity,
    RawHttpRequest,
    RequestContext,
    SignableRequest,
    VendorAuthMinter,
    VendorAuthVerifier,
    VENDOR_AUTH_MINTER,
    VENDOR_AUTH_VERIFIER,
} from '@webpieces/core-context';
import { GcpOidc } from '@webpieces/gcp-identity';
import {
    ClientConfig,
    ClientHttpFactory,
    MissingVendorAuthMinterError,
} from '@webpieces/http-client-node'; // eslint-disable-line @webpieces/enforce-architecture -- test-only loopback proof that a server's outbound OIDC client and its inbound vendor verifier are independent DI roles (#1358)
import {
    Binder,
    ContainerBinder,
    OIDC_HOOK,
    OidcHook,
    VERIFIED_MACHINE_CALLER,
    WebpiecesRouter,
    WebpiecesRouterFactory,
} from '@webpieces/http-routing';
import { WebpiecesExpressRouter } from '../WebpiecesExpressRouter';

/**
 * #1358, end to end over loopback, in the exact shape of the consumer that failed in production:
 *
 *   CLI process ──vendorAuth('bugfixer-agent')──▶ API server ──oidcSameProject()──▶ fsdb server
 *   (binds the MINTER)                            (binds the VERIFIER, which        (OIDC only)
 *                                                  calls fsdb to check the token)
 *
 * Three real WebpiecesRouters, two real express listeners, real ClientHttpFactory/Binder RPC clients.
 * Only the external identity edge (Google's metadata server, Google's token verification) is a stub.
 * The API server's verifier depends on its typed `oidcSameProject()` fsdb client — the very
 * dependency that closed a DI cycle when one `VendorAuthHook` served both directions.
 */

const GOOD_WORKER_TOKEN = 'worker-token-good';
const BAD_WORKER_TOKEN = 'worker-token-revoked';
const MACHINE_ID = 'machine-42';
const OIDC_TOKEN = 'api-server-google-identity';
const FSDB = 'fsdb';
const BUGFIXER_API = 'bugfixer-api';

/** Trusted context the API's verifier derives from the credential it just checked. */
const MACHINE_ORG = ContextKey.trusted<string>(
    'machineOrg',
    'derived by the API server VendorAuthVerifier from a worker token fsdb resolved',
);

class ResolveAgentCallRequest {
    constructor(public readonly workerToken: string) {}
}

class ResolveAgentCallResponse {
    constructor(
        public readonly machineId: string | undefined,
        public readonly org: string | undefined,
    ) {}
}

/** fsdb's data-access contract: authenticated by the API server's OWN Google identity (OIDC). */
@Rpc()
@ApiPath('/fsdb')
abstract class FsdbAgentApi {
    @Endpoint(POST, '/resolve-agent-call', READ, RPC)
    @WpAuth([oidcSameProject()])
    @WpAuthorization({ authType: AuthorizationType.SERVICE_ONLY })
    // webpieces-disable no-unmanaged-exceptions -- abstract contract stub, never executed
    resolveAgentCall(_request: ResolveAgentCallRequest): Promise<ResolveAgentCallResponse> {
        throw new Error('contract only');
    }
}

class FirebaseTokenRequest {
    constructor(public readonly purpose: string) {}
}

class FirebaseTokenResponse {
    constructor(
        public readonly machineId: string,
        public readonly org: string,
    ) {}
}

/** The API server's worker contract: a VENDOR credential (the worker token), not a Google identity. */
@ApiPath('/agent')
abstract class BugfixerAgentApi {
    @Endpoint(POST, '/firebase-token', WRITE, EXTERNAL_INBOUND, { calledBy: 'bugfixer-agent', rawBody: true })
    @WpAuth([vendorAuth('bugfixer-agent')])
    @WpAuthorization({ authType: AuthorizationType.SERVICE_ONLY })
    // webpieces-disable no-unmanaged-exceptions -- abstract contract stub, never executed
    firebaseToken(_request: FirebaseTokenRequest): Promise<FirebaseTokenResponse> {
        throw new Error('contract only');
    }
}

/** Everything that ran, across all three processes. Reset per test. */
class Probe {
    apiVerifierConstructed = 0;
    apiVerifies = 0;
    apiVerifierSawUrl: string | undefined;
    apiVerifierSawBody: string | undefined;
    apiControllerCalls = 0;
    apiControllerSawMachine: string | undefined;
    apiControllerSawOrg: string | undefined;
    apiServerRequests = 0;
    apiServerMints = 0;
    fsdbCalls: string[] = [];
    fsdbOidcTokens: string[] = [];
    fsdbVendorVerifies = 0;
    cliMints = 0;
    cliMintedFor: SignableRequest | undefined;
    cliVerifierConstructed = 0;
    cliVerifies = 0;
}

let probe = new Probe();

// ---------------------------------------------------------------- fsdb server (OIDC only)

class AcceptApiServerOidc extends OidcHook {
    override async verifyOidc(token: string, _methods: OidcAuthMethods): Promise<AuthenticatedMachineIdentity> {
        probe.fsdbOidcTokens.push(token);
        if (token !== OIDC_TOKEN) throw new ApiUnauthorizedError('not the API server identity');
        return new AuthenticatedMachineIdentity('oidc', 'bugfixer-api@project.iam.gserviceaccount.com');
    }
}

/** fsdb serves no vendorAuth endpoint; a verifier bound here must never be consulted. */
class FsdbVendorVerifierTrap extends VendorAuthVerifier {
    override async verify(_name: string, _request: RawHttpRequest): Promise<AuthenticatedCaller> {
        probe.fsdbVendorVerifies += 1;
        throw new ApiUnauthorizedError('fsdb never verifies vendor credentials');
    }
}

@injectable()
class FsdbController extends FsdbAgentApi {
    override async resolveAgentCall(request: ResolveAgentCallRequest): Promise<ResolveAgentCallResponse> {
        probe.fsdbCalls.push(request.workerToken);
        return request.workerToken === GOOD_WORKER_TOKEN
            ? new ResolveAgentCallResponse(MACHINE_ID, 'org-7')
            : new ResolveAgentCallResponse(undefined, undefined);
    }
}

// ---------------------------------------------------------------- API server (VERIFIER + OIDC client)

/** Google's metadata server, stubbed: the API server's own identity token for fsdb. */
class StubGcpOidc {
    readonly audiences: string[] = [];

    mintIdToken(audience: string): Promise<string> {
        this.audiences.push(audience);
        return Promise.resolve(OIDC_TOKEN);
    }
}

/** The server's INBOUND role, exactly the consumer's shape: it checks the token through fsdb. */
@injectable()
class AgentTokenVerifier extends VendorAuthVerifier {
    constructor(
        // webpieces-disable inject-annotation-not-needed-for-concrete-class -- abstract contract class is the token; esbuild elides design:paramtypes
        @inject(FsdbAgentApi) private readonly fsdb: FsdbAgentApi,
    ) {
        super();
        probe.apiVerifierConstructed += 1;
    }

    override async verify(_name: string, request: RawHttpRequest): Promise<AuthenticatedCaller> {
        probe.apiVerifies += 1;
        probe.apiVerifierSawUrl = request.raw.absoluteUrl;
        probe.apiVerifierSawBody = request.raw.rawBody.toString('utf8');
        const header = request.getHeader('authorization') ?? '';
        const workerToken = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
        const resolved = await this.fsdb.resolveAgentCall(new ResolveAgentCallRequest(workerToken));
        if (resolved.machineId === undefined || resolved.org === undefined) {
            throw new ApiUnauthorizedError('worker token did not resolve to a connected machine');
        }
        return new AuthenticatedCaller(
            undefined,
            [],
            [new ContextTuple(MACHINE_ORG, resolved.org)],
            {},
            new AuthenticatedMachineIdentity('vendor:bugfixer-agent', resolved.machineId),
        );
    }
}

/** Bound in the API server too, to prove its OIDC hop to fsdb never asks the vendor minter. */
@injectable()
class ApiServerMinterTrap extends VendorAuthMinter {
    override async mint(_name: string, _request: SignableRequest): Promise<Map<string, string>> {
        probe.apiServerMints += 1;
        throw new Error('the API server sends no vendorAuth call in this topology');
    }

    override async refresh(_name: string): Promise<void> {
        probe.apiServerMints += 1;
    }
}

@injectable()
class BugfixerAgentController extends BugfixerAgentApi {
    override async firebaseToken(_request: FirebaseTokenRequest): Promise<FirebaseTokenResponse> {
        probe.apiControllerCalls += 1;
        probe.apiControllerSawMachine = RequestContext.getTrusted(VERIFIED_MACHINE_CALLER)?.identity;
        probe.apiControllerSawOrg = RequestContext.getTrusted(MACHINE_ORG);
        return new FirebaseTokenResponse(probe.apiControllerSawMachine ?? '', probe.apiControllerSawOrg ?? '');
    }
}

// ---------------------------------------------------------------- CLI process (MINTER only, plus a trap)

/** The CLI's OUTBOUND role: it reads the worker token it already holds. No RPC, no validation. */
@injectable()
class AgentTokenMinter extends VendorAuthMinter {
    constructor() {
        super();
    }

    override async mint(_name: string, request: SignableRequest): Promise<Map<string, string>> {
        probe.cliMints += 1;
        probe.cliMintedFor = request;
        return new Map([['Authorization', `Bearer ${heldWorkerToken}`]]);
    }

    override async refresh(_name: string): Promise<void> {
        // the pairing credential is long-lived in this fixture
    }
}

/** A verifier bound in the SENDING process: it must never be called to send a request. */
@injectable()
class CliVerifierTrap extends VendorAuthVerifier {
    constructor() {
        super();
        probe.cliVerifierConstructed += 1;
    }

    override async verify(_name: string, _request: RawHttpRequest): Promise<AuthenticatedCaller> {
        probe.cliVerifies += 1;
        throw new ApiUnauthorizedError('the CLI never receives vendor calls');
    }
}

let heldWorkerToken = GOOD_WORKER_TOKEN;

// ---------------------------------------------------------------- harness

function module(configure: (binder: Binder, options: ContainerModuleLoadOptions) => void): ContainerModule {
    return new ContainerModule((options: ContainerModuleLoadOptions) => configure(new ContainerBinder(options), options));
}

async function listen(router: WebpiecesRouter, probeRequests?: () => void): Promise<Server> {
    const app = express();
    if (probeRequests) {
        app.use((_req: Request, _res: ExpressResponse, next: NextFunction) => {
            probeRequests();
            next();
        });
    }
    return new WebpiecesExpressRouter(router).bindAndStartExpress(app, 0);
}

function urlOf(server: Server): string {
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function close(server: Server): Promise<void> {
    server.closeAllConnections();
    await new Promise<void>((resolve: () => void) => server.close(() => resolve()));
}

async function cliRouter(bindMinter: boolean): Promise<WebpiecesRouter> {
    return WebpiecesRouterFactory.create({
        appBindings: [
            module((binder: Binder) => {
                binder.bind(VENDOR_AUTH_VERIFIER).to(CliVerifierTrap).inSingletonScope();
                if (bindMinter) binder.bind(VENDOR_AUTH_MINTER).to(AgentTokenMinter).inSingletonScope();
                binder.createRpcClientAndBind(BugfixerAgentApi, BUGFIXER_API);
            }),
        ],
    });
}

describe('vendorAuth over loopback: CLI minter -> API verifier -> fsdb over OIDC (#1358)', () => {
    let fsdbServer: Server;
    let apiServer: Server;
    let apiUrl: string;
    let gcpOidc: StubGcpOidc;
    let apiVerifierConstructedAtBoot = 0;

    beforeAll(async () => {
        if (!HeaderRegistry.isConfigured()) HeaderRegistry.configure([], true);
        ClientRegistry.resetForTests();

        const fsdb = await WebpiecesRouterFactory.create({
            appBindings: [
                module((binder: Binder) => {
                    binder.bind(OIDC_HOOK).toConstantValue(new AcceptApiServerOidc());
                    binder.bind(VENDOR_AUTH_VERIFIER).toConstantValue(new FsdbVendorVerifierTrap());
                    binder.bind(FsdbController).toSelf().inSingletonScope();
                }),
            ],
        });
        fsdb.addRoutes(FsdbAgentApi, FsdbController);
        fsdbServer = await listen(fsdb);
        ClientRegistry.addUrlMapping(FSDB, urlOf(fsdbServer));

        gcpOidc = new StubGcpOidc();
        // Registration order deliberately puts the verifier BEFORE the client it depends on.
        const api = await WebpiecesRouterFactory.create({
            appBindings: [
                module((binder: Binder) => {
                    binder.bind(VENDOR_AUTH_VERIFIER).to(AgentTokenVerifier).inSingletonScope();
                    binder.bind(VENDOR_AUTH_MINTER).to(ApiServerMinterTrap).inSingletonScope();
                    binder.createRpcClientAndBind(FsdbAgentApi, FSDB);
                    binder.bind(BugfixerAgentController).toSelf().inSingletonScope();
                }),
            ],
            appOverrides: new ContainerModule(async (options: ContainerModuleLoadOptions) => {
                // webpieces-disable no-any-unknown -- test double for the metadata-server edge: only mintIdToken is reached
                (await options.rebind(GcpOidc)).toConstantValue(gcpOidc as unknown as GcpOidc);
            }),
        });
        api.addRoutes(BugfixerAgentApi, BugfixerAgentController);
        apiVerifierConstructedAtBoot = probe.apiVerifierConstructed;
        apiServer = await listen(api, () => {
            probe.apiServerRequests += 1;
        });
        apiUrl = urlOf(apiServer);
        ClientRegistry.addUrlMapping(BUGFIXER_API, apiUrl);
    });

    afterAll(async () => {
        ClientRegistry.resetForTests();
        await close(apiServer);
        await close(fsdbServer);
    });

    beforeEach(() => {
        probe = new Probe();
        heldWorkerToken = GOOD_WORKER_TOKEN;
        gcpOidc.audiences.length = 0;
    });

    async function postAsWorker(token: string | undefined): Promise<globalThis.Response> {
        const headers: Record<string, string> = { 'content-type': 'application/json' };
        if (token !== undefined) headers['authorization'] = `Bearer ${token}`;
        return fetch(`${apiUrl}/agent/firebase-token`, {
            method: 'POST',
            headers,
            body: JSON.stringify(new FirebaseTokenRequest('sign-in')),
            signal: AbortSignal.timeout(5000),
        });
    }

    describe('INBOUND: the real AuthFilter invokes the verifier, which calls fsdb over OIDC', () => {
        it('a valid worker credential establishes the machine caller and its trusted context', async () => {
            const response = await postAsWorker(GOOD_WORKER_TOKEN);

            expect(response.status).toBe(200);
            expect(await response.json()).toEqual({ machineId: MACHINE_ID, org: 'org-7' });
            expect(probe.apiControllerCalls).toBe(1);
            expect(probe.apiControllerSawMachine).toBe(MACHINE_ID);
            expect(probe.apiControllerSawOrg).toBe('org-7');
            // Exactly one verification: the fsdb hop did not recurse into the original verifier.
            expect(probe.apiVerifies).toBe(1);
            expect(probe.fsdbCalls).toEqual([GOOD_WORKER_TOKEN]);
        });

        it('the downstream hop authenticates with OIDC and asks no vendor minter or verifier', async () => {
            await postAsWorker(GOOD_WORKER_TOKEN);

            expect(gcpOidc.audiences).toEqual([urlOf(fsdbServer)]);
            expect(probe.fsdbOidcTokens).toEqual([OIDC_TOKEN]);
            expect(probe.apiServerMints).toBe(0);
            expect(probe.fsdbVendorVerifies).toBe(0);
        });

        it('an invalid credential is refused 401 before the controller runs', async () => {
            const response = await postAsWorker(BAD_WORKER_TOKEN);

            expect(response.status).toBe(401);
            expect(probe.apiControllerCalls).toBe(0);
            expect(probe.apiVerifies).toBe(1);
            expect(probe.fsdbCalls).toEqual([BAD_WORKER_TOKEN]);
        });

        it('no credential at all is refused 401 before the controller runs', async () => {
            const response = await postAsWorker(undefined);

            expect(response.status).toBe(401);
            expect(probe.apiControllerCalls).toBe(0);
        });

        it('the verifier was constructed ONCE, at boot, around the real fsdb RPC client', async () => {
            // Boot resolved AuthFilter -> verifier -> fsdb proxy -> NodeProxyClient: the chain that
            // was a cycle under the unified hook. A request constructs nothing more.
            expect(apiVerifierConstructedAtBoot).toBe(1);
            await postAsWorker(GOOD_WORKER_TOKEN);
            expect(probe.apiVerifierConstructed).toBe(0);
        });
    });

    describe('OUTBOUND: the CLI minter sends with no help from any verifier', () => {
        it('mints over the exact final url and bytes, and the API server verifies those same bytes', async () => {
            const cli = await cliRouter(true);
            const constructedAtBoot = probe.cliVerifierConstructed;
            const agentApi = cli.getContainer().get(BugfixerAgentApi);

            const response = await RequestContext.run(() => agentApi.firebaseToken(new FirebaseTokenRequest('sign-in')));

            expect(response).toEqual({ machineId: MACHINE_ID, org: 'org-7' });
            expect(probe.cliMints).toBe(1);
            expect(probe.cliMintedFor?.url).toBe(`${apiUrl}/agent/firebase-token`);
            expect(probe.cliMintedFor?.httpMethod).toBe('POST');
            // What was signed is what arrived, byte for byte, at the URL the server reconstructed.
            expect(probe.apiVerifierSawBody).toBe(probe.cliMintedFor?.body);
            expect(probe.apiVerifierSawUrl).toBe(probe.cliMintedFor?.url);
            // The CLI's own verifier binding played no part in sending.
            expect(probe.cliVerifies).toBe(0);
            expect(probe.cliVerifierConstructed).toBe(constructedAtBoot);
        });

        it('a CLI holding a revoked token is refused by the server, and refreshes ONCE then fails', async () => {
            heldWorkerToken = BAD_WORKER_TOKEN;
            const cli = await cliRouter(true);
            const agentApi = cli.getContainer().get(BugfixerAgentApi);

            await expect(
                RequestContext.run(() => agentApi.firebaseToken(new FirebaseTokenRequest('sign-in'))),
            ).rejects.toThrow();

            // One 401, one refresh, one re-send, then the failure — never a loop.
            expect(probe.cliMints).toBe(2);
            expect(probe.apiServerRequests).toBe(2);
            expect(probe.apiControllerCalls).toBe(0);
        });

        it('with NO minter bound, refuses with MissingVendorAuthMinterError and sends nothing', async () => {
            const cli = await cliRouter(false);
            const agentApi = cli.getContainer().get(BugfixerAgentApi);

            const refused = RequestContext.run(() => agentApi.firebaseToken(new FirebaseTokenRequest('sign-in')));

            await expect(refused).rejects.toBeInstanceOf(MissingVendorAuthMinterError);
            await expect(refused).rejects.toThrow(/VENDOR_AUTH_MINTER/);
            expect(probe.apiServerRequests).toBe(0);
            expect(probe.cliVerifies).toBe(0);
        });
    });

    describe('NEITHER role bound: an OIDC-only process boots and calls fsdb', () => {
        it('constructs and uses a plain oidcSameProject() client with no vendor role at all', async () => {
            const plain = await WebpiecesRouterFactory.create({
                appBindings: [module((binder: Binder) => binder.createRpcClientAndBind(FsdbAgentApi, FSDB))],
                appOverrides: new ContainerModule(async (options: ContainerModuleLoadOptions) => {
                    // webpieces-disable no-any-unknown -- test double for the metadata-server edge: only mintIdToken is reached
                    (await options.rebind(GcpOidc)).toConstantValue(gcpOidc as unknown as GcpOidc);
                }),
            });
            const container = plain.getContainer();
            expect(container.isBound(VENDOR_AUTH_MINTER)).toBe(false);
            expect(container.isBound(VENDOR_AUTH_VERIFIER)).toBe(false);

            const fsdbClient = container.get(FsdbAgentApi);
            const resolved = await RequestContext.run(() =>
                fsdbClient.resolveAgentCall(new ResolveAgentCallRequest(GOOD_WORKER_TOKEN)),
            );

            expect(resolved).toEqual({ machineId: MACHINE_ID, org: 'org-7' });
            expect(probe.fsdbOidcTokens).toEqual([OIDC_TOKEN]);
        });

        it('ClientHttpFactory itself resolves with no vendor role bound', async () => {
            const plain = await WebpiecesRouterFactory.create({ appBindings: [] });
            const factory = plain.getContainer().get(ClientHttpFactory);
            expect(() => factory.createRpcClient(FsdbAgentApi, new ClientConfig(FSDB, ClientRole.SERVER))).not.toThrow();
        });
    });
});
