import 'reflect-metadata';
import { ContainerModule, ContainerModuleLoadOptions, inject, injectable } from 'inversify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    ApiPath,
    AuthorizationType,
    Endpoint,
    POST,
    READ,
    Rpc,
    RPC,
    WpAuth,
    WpAuthorization,
    oidcSameProject,
    toError,
} from '@webpieces/core-util';
import {
    AuthenticatedCaller,
    RawHttpRequest,
    SignableRequest,
    VendorAuthMinter,
    VendorAuthVerifier,
    VENDOR_AUTH_MINTER,
    VENDOR_AUTH_VERIFIER,
} from '@webpieces/core-context';
import { GcpOidc } from '@webpieces/gcp-identity';
import { ClientHttpFactory, NodeProxyClient } from '@webpieces/http-client-node';
import { Binder, ContainerBinder } from '../Binder';
import { AuthFilter } from '../filters/AuthFilter';
import { WebpiecesRouter, WebpiecesRouterFactory } from '../WebpiecesRouter';

/**
 * #1358 — the PRODUCTION-SHAPED DI regression. 0.4.958/0.4.959 bound ONE `VendorAuthHook` for both
 * directions, and `NodeProxyClient` injected it: so resolving ANY RPC proxy — including the ordinary
 * `oidcSameProject()` client an inbound verifier uses to look a credential up — constructed the
 * verifier, whose constructor asked for that same proxy. `Circular dependency found`, before the
 * server could listen.
 *
 * Everything here is the REAL framework: `WebpiecesRouterFactory` (the framework module, autobind,
 * the real `ClientHttpFactory` + `Provider<NodeProxyClient>`), the real node `ContainerBinder`
 * (`createRpcClientAndBind`) and a real `@Rpc` contract with `oidcSameProject()`. The RPC identity is
 * NEVER replaced by an in-memory fake: that exact substitution is what hid the bug in the consumer's
 * harness. Only the network edges are stubbed, and they are asserted UNTOUCHED: construction mints,
 * refreshes, verifies and fetches nothing.
 */

class ResolveAgentCallRequest {
    constructor(public readonly workerToken: string) {}
}

class ResolveAgentCallResponse {
    constructor(public readonly machineId: string) {}
}

/** The downstream data-access contract an inbound verifier checks a credential with. OIDC, not vendor. */
@Rpc()
@ApiPath('/fsdb')
abstract class CredentialLookupApi {
    @Endpoint(POST, '/resolve-agent-call', READ, RPC)
    @WpAuth([oidcSameProject()])
    @WpAuthorization({ authType: AuthorizationType.SERVICE_ONLY })
    // webpieces-disable no-unmanaged-exceptions -- abstract contract stub, never executed
    resolveAgentCall(_request: ResolveAgentCallRequest): Promise<ResolveAgentCallResponse> {
        throw new Error('contract only');
    }
}

/** Every construction and every credential operation, so a test can prove which ran and which did not. */
class Tally {
    verifierConstructed = 0;
    plainVerifierConstructed = 0;
    minterConstructed = 0;
    verifies = 0;
    mints = 0;
    refreshes = 0;
}

let tally = new Tally();

/** The SERVER's inbound role, shaped exactly like the consumer's: it depends on the OIDC RPC proxy. */
@injectable()
class LookupVendorVerifier extends VendorAuthVerifier {
    constructor(
        // webpieces-disable inject-annotation-not-needed-for-concrete-class -- an abstract contract class is the DI token; esbuild/vitest elides design:paramtypes
        @inject(CredentialLookupApi) public readonly lookup: CredentialLookupApi,
    ) {
        super();
        tally.verifierConstructed += 1;
    }

    override async verify(_name: string, _request: RawHttpRequest): Promise<AuthenticatedCaller> {
        tally.verifies += 1;
        throw new Error('verify must never run during construction');
    }
}

/** An inbound verifier with no dependencies, to observe what resolving AuthFilter constructs. */
@injectable()
class PlainVendorVerifier extends VendorAuthVerifier {
    constructor() {
        super();
        tally.plainVerifierConstructed += 1;
    }

    override async verify(_name: string, _request: RawHttpRequest): Promise<AuthenticatedCaller> {
        tally.verifies += 1;
        throw new Error('verify must never run during construction');
    }
}

/** The CLIENT's outbound role, shaped like the CLI's signer: it reads a credential it already holds. */
@injectable()
class HeldTokenMinter extends VendorAuthMinter {
    constructor() {
        super();
        tally.minterConstructed += 1;
    }

    override async mint(_name: string, _request: SignableRequest): Promise<Map<string, string>> {
        tally.mints += 1;
        return new Map([['Authorization', 'Bearer held-worker-token']]);
    }

    override async refresh(_name: string): Promise<void> {
        tally.refreshes += 1;
    }
}

/** What each BindModule registers, in the order given — the order is the variable under test. */
enum Registration {
    LOOKUP_CLIENT = 'lookup-client',
    VERIFIER = 'verifier',
    PLAIN_VERIFIER = 'plain-verifier',
    MINTER = 'minter',
}

function register(binder: Binder, what: Registration): void {
    switch (what) {
        case Registration.LOOKUP_CLIENT:
            binder.createRpcClientAndBind(CredentialLookupApi, 'fsdb');
            return;
        case Registration.VERIFIER:
            binder.bind(VENDOR_AUTH_VERIFIER).to(LookupVendorVerifier).inSingletonScope();
            return;
        case Registration.PLAIN_VERIFIER:
            binder.bind(VENDOR_AUTH_VERIFIER).to(PlainVendorVerifier).inSingletonScope();
            return;
        case Registration.MINTER:
            binder.bind(VENDOR_AUTH_MINTER).to(HeldTokenMinter).inSingletonScope();
            return;
    }
}

/** The real router container, with the app's registrations made through the real node Binder. */
async function boot(order: Registration[]): Promise<WebpiecesRouter> {
    const appModule = new ContainerModule((options: ContainerModuleLoadOptions) => {
        const binder = new ContainerBinder(options);
        for (const what of order) register(binder, what);
    });
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- re-thrown as a SHORT plain Error: inversify's resolution error references the client proxy, which a reporter cannot serialize
    try {
        return await WebpiecesRouterFactory.create({ appBindings: [appModule] });
    } catch (err: unknown) { // webpieces-disable no-any-unknown -- normalized immediately
        const error = toError(err);
        throw new Error(`the router failed to assemble its DI graph: ${error.message.slice(0, 300)}`);
    }
}

describe('vendor auth roles are independent at construction (#1358)', () => {
    let fetchSpy: ReturnType<typeof vi.fn>;
    let oidcSpy: ReturnType<typeof vi.spyOn>;
    let createdClients: unknown[];

    beforeEach(() => {
        tally = new Tally();
        createdClients = [];
        fetchSpy = vi.fn(() => Promise.reject(new Error('no network during construction')));
        vi.stubGlobal('fetch', fetchSpy);
        oidcSpy = vi.spyOn(GcpOidc.prototype, 'mintIdToken');
        const realCreate = ClientHttpFactory.prototype.createRpcClient;
        vi.spyOn(ClientHttpFactory.prototype, 'createRpcClient').mockImplementation(function (
            this: ClientHttpFactory,
            ...args: Parameters<ClientHttpFactory['createRpcClient']>
        ) {
            const created = realCreate.apply(this, args);
            createdClients.push(created);
            return created;
        });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    function expectNoCredentialWorkOrNetwork(): void {
        expect(tally.mints).toBe(0);
        expect(tally.refreshes).toBe(0);
        expect(tally.verifies).toBe(0);
        expect(oidcSpy).not.toHaveBeenCalled();
        expect(fetchSpy).not.toHaveBeenCalled();
    }

    const orders: Array<[string, Registration[]]> = [
        ['client registered first', [Registration.LOOKUP_CLIENT, Registration.VERIFIER]],
        ['verifier registered first', [Registration.VERIFIER, Registration.LOOKUP_CLIENT]],
    ];

    for (const [label, order] of orders) {
        it(`VERIFIER-ONLY: a verifier depending on a real oidcSameProject() RPC proxy resolves — ${label}`, async () => {
            const container = (await boot(order)).getContainer();

            const verifier = container.get<LookupVendorVerifier>(VENDOR_AUTH_VERIFIER);
            const authFilter = container.get(AuthFilter);
            const lookup = container.get(CredentialLookupApi);

            expect(verifier).toBeInstanceOf(LookupVendorVerifier);
            expect(authFilter).toBeInstanceOf(AuthFilter);
            // The verifier holds the REAL proxy the framework's ClientHttpFactory built — no fake.
            expect(createdClients).toHaveLength(1);
            expect(verifier.lookup).toBe(createdClients[0]);
            expect(lookup).toBe(verifier.lookup);
            expect(tally.verifierConstructed).toBe(1);
            expectNoCredentialWorkOrNetwork();
        });
    }

    const bothOrders: Array<[string, Registration[]]> = [
        ['client, verifier, minter', [Registration.LOOKUP_CLIENT, Registration.VERIFIER, Registration.MINTER]],
        ['minter, verifier, client', [Registration.MINTER, Registration.VERIFIER, Registration.LOOKUP_CLIENT]],
        ['verifier, minter, client', [Registration.VERIFIER, Registration.MINTER, Registration.LOOKUP_CLIENT]],
    ];

    for (const [label, order] of bothOrders) {
        it(`BOTH: the server boots and the RPC proxy holds no reference to the inbound verifier — ${label}`, async () => {
            // Booting already resolved AuthFilter (the router installs it on every route), i.e. the
            // EXACT production chain AuthFilter -> verifier -> oidc RPC proxy -> NodeProxyClient. With
            // the unified hook that chain looped back into the verifier: Circular dependency found.
            const container = (await boot(order)).getContainer();
            expect(tally.verifierConstructed).toBe(1);
            expect(createdClients).toHaveLength(1);

            const verifier = container.get<LookupVendorVerifier>(VENDOR_AUTH_VERIFIER);
            const minter = container.get(VENDOR_AUTH_MINTER);
            expect(verifier.lookup === container.get(CredentialLookupApi)).toBe(true);
            expect(verifier.lookup === createdClients[0]).toBe(true);
            expect(minter).toBeInstanceOf(HeldTokenMinter);

            // A fresh outbound client, built exactly as createRpcClient builds one, depends on the
            // OUTBOUND role and never on the inbound one.
            const proxyClient = container.get(NodeProxyClient);
            const collaborators: unknown[] = Object.values(proxyClient);
            // Identity checks by hand: a matcher that pretty-prints would walk into the client proxy.
            expect(collaborators.includes(minter)).toBe(true);
            expect(collaborators.includes(verifier)).toBe(false);
            expect(tally.verifierConstructed).toBe(1);
            expectNoCredentialWorkOrNetwork();
        });
    }

    it('BOTH: resolving AuthFilter does not construct an unrelated outbound minter', async () => {
        const container = (await boot([Registration.MINTER, Registration.PLAIN_VERIFIER])).getContainer();

        container.get(AuthFilter);

        expect(tally.plainVerifierConstructed).toBe(1);
        expect(tally.minterConstructed).toBe(0);
        expectNoCredentialWorkOrNetwork();
    });

    for (const [label, order] of [
        ['client registered first', [Registration.LOOKUP_CLIENT, Registration.MINTER]],
        ['minter registered first', [Registration.MINTER, Registration.LOOKUP_CLIENT]],
    ] as Array<[string, Registration[]]>) {
        it(`MINTER-ONLY: a client-side process resolves its RPC proxy and AuthFilter — ${label}`, async () => {
            const container = (await boot(order)).getContainer();

            expect(container.get(CredentialLookupApi)).toBe(createdClients[0]);
            container.get(AuthFilter);

            expect(tally.minterConstructed).toBe(1);
            expect(container.isBound(VENDOR_AUTH_VERIFIER)).toBe(false);
            expectNoCredentialWorkOrNetwork();
        });
    }

    it('NEITHER: an OIDC-only process boots with no vendor role bound at all', async () => {
        const container = (await boot([Registration.LOOKUP_CLIENT])).getContainer();

        expect(container.get(CredentialLookupApi)).toBe(createdClients[0]);
        container.get(AuthFilter);

        expect(container.isBound(VENDOR_AUTH_MINTER)).toBe(false);
        expect(container.isBound(VENDOR_AUTH_VERIFIER)).toBe(false);
        expect(tally.minterConstructed).toBe(0);
        expectNoCredentialWorkOrNetwork();
    });
});
