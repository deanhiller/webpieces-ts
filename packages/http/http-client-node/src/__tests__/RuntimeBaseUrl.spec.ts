import 'reflect-metadata';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    ApiCallContextHolder,
    ApiPath,
    AuthOidc,
    ClientRegistry,
    DestinationTrust,
    Endpoint,
    Filter,
    Public,
    Rpc,
    Service,
    TestCaseRecorder,
    WebpiecesCoreHeaders,
} from '@webpieces/core-util';
import type { AnyUntrustedContextKey, ApiCallContext } from '@webpieces/core-util';
import type { RequestContextHeaders } from '@webpieces/core-context';
import { RequestContext } from '@webpieces/core-context';
import type { GcpOidc } from '@webpieces/gcp-identity';
import type { ApiPrototype } from '@webpieces/http-client-core';
import { buildClientProxy, ClientFilterDefinition, ClientRequest } from '@webpieces/http-client-core';
import { AddressResolver } from '../AddressResolver';
import { ClientConfig } from '../ClientConfig';
import {
    DeployedServiceHost,
    RuntimeHostFromContext,
    RuntimeHostFromContextAllowingInternalAddresses,
} from '../HostPolicy';
import { NodeProxyClient } from '../NodeProxyClient';
import { SsrfRefusedError } from '../SsrfRefusedError';

class DeliverRequest {
    constructor(public readonly eventId: string) {}
}

/**
 * The backlog's own shape: OUR published contract, delivered to a URL the PARTNER registered. It is
 * @Public because the partner authenticates us by our signature, not by a credential we mint.
 */
@Rpc()
@ApiPath('/webhooks')
abstract class PartnerWebhookApi {
    @Endpoint('/deliver', 'rpc')
    @Public()
    // webpieces-disable no-unmanaged-exceptions -- abstract contract stub, never executed
    deliver(_request: DeliverRequest): Promise<void> {
        throw new Error('contract only');
    }
}

/** A contract whose endpoint expects a credential minted for an audience WE choose. */
@Rpc()
@ApiPath('/internal')
abstract class OidcApi {
    @Endpoint('/work', 'rpc')
    @AuthOidc()
    // webpieces-disable no-unmanaged-exceptions -- abstract contract stub, never executed
    work(_request: DeliverRequest): Promise<void> {
        throw new Error('contract only');
    }
}

class StubHeaders {
    buildOutboundHeaders(_destination: DestinationTrust): Map<string, string> {
        return new Map<string, string>();
    }

    findRecorder(): TestCaseRecorder | undefined {
        return undefined;
    }
}

/** The `api` log-tag seam LogApiCall stamps into. This suite is not about log tags. */
class NoopApiCallContext implements ApiCallContext {
    isActive(): boolean {
        return true;
    }

    // webpieces-disable no-any-unknown -- a context value is heterogeneous; this impl records nothing
    set(_contextKey: AnyUntrustedContextKey, _value: unknown): void {}

    remove(_contextKey: AnyUntrustedContextKey): void {}
}

class StubOidc {
    mintIdToken(_audience: string): Promise<string> {
        return Promise.resolve('never-used');
    }
}

/** An AddressResolver that answers from a table, so the policy is testable with no DNS. */
class FakeAddressResolver extends AddressResolver {
    constructor(private readonly answers: Map<string, string[]>) {
        super();
    }

    override async resolve(hostname: string): Promise<string[]> {
        const found = this.answers.get(hostname);
        if (!found) {
            throw new Error(`no test answer registered for ${hostname}`);
        }
        return found;
    }
}

/** Everything public resolves to one public address unless a test says otherwise. */
function publicDns(): FakeAddressResolver {
    return new FakeAddressResolver(
        new Map([
            ['api.partner.example', ['93.184.216.34']],
            ['redirector.partner.example', ['93.184.216.34']],
            ['rebind.partner.example', ['93.184.216.34', '10.0.0.5']],
            ['server2.example', ['93.184.216.34']],
        ]),
    );
}

/** Records what actually went on the wire, in order. */
class SentCall {
    constructor(
        public readonly url: string,
        public readonly body: string | undefined,
        public readonly headers: Record<string, string>,
    ) {}
}

let sent: SentCall[] = [];

/** Stub the transport, answering call `i` with `responses[i]` (the last one repeats). */
function stubTransport(responses: Response[]): void {
    let call = 0;
    vi.stubGlobal(
        'fetch',
        vi.fn((url: string, options: RequestInit) => {
            sent.push(new SentCall(url, options.body as string | undefined, options.headers as Record<string, string>));
            const response = responses[Math.min(call, responses.length - 1)];
            call += 1;
            return Promise.resolve(response.clone());
        }),
    );
}

function ok(): Response {
    return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function redirectTo(location: string): Response {
    return new Response(null, { status: 302, headers: { location } });
}

/** The urls that actually went on the wire, in order. */
function sentUrls(): string[] {
    return sent.map((call: SentCall) => call.url);
}

/** A real NodeProxyClient bound to a contract, behind the same Proxy the factory would build. */
function client<T extends object>(
    api: ApiPrototype<T>,
    config: ClientConfig,
    filters: ClientFilterDefinition[],
): T {
    const proxyClient = new NodeProxyClient(
        // webpieces-disable no-any-unknown -- test double: only buildOutboundHeaders/findRecorder are reached
        new StubHeaders() as unknown as RequestContextHeaders,
        // webpieces-disable no-any-unknown -- test double: no @AuthOidc endpoint is ever CALLED here
        new StubOidc() as unknown as GcpOidc,
    );
    proxyClient.init(api, config, filters);
    return buildClientProxy(api, proxyClient);
}

function partnerClient(filters: ClientFilterDefinition[] = []): PartnerWebhookApi {
    return client(
        PartnerWebhookApi,
        new ClientConfig('partner-webhooks', new RuntimeHostFromContext(publicDns())),
        filters,
    );
}

/** Run `fn` with an OVERRIDE_BASE_URL in scope, exactly as a fan-out loop would. */
function withOverride<T>(url: string, fn: () => Promise<T>): Promise<T> {
    return RequestContext.run(() => {
        RequestContext.putUntrusted(WebpiecesCoreHeaders.OVERRIDE_BASE_URL, url);
        return fn();
    });
}

beforeEach(() => {
    ApiCallContextHolder.install(new NoopApiCallContext());
    sent = [];
    stubTransport([ok()]);
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('the runtime base-URL override', () => {
    it('sends ONE call to the url the context supplied', async () => {
        await withOverride('https://api.partner.example', () =>
            partnerClient().deliver(new DeliverRequest('e1')),
        );

        expect(sent).toHaveLength(1);
        expect(sent[0].url).toBe('https://api.partner.example/webhooks/deliver');
    });

    it('does NOT leak into the next call — one client, two partner urls, in one process', async () => {
        // The fan-out the backlog describes: ONE client reused across N partner URLs.
        const partner = partnerClient();

        await withOverride('https://api.partner.example', () => partner.deliver(new DeliverRequest('e1')));
        await withOverride('https://redirector.partner.example', () => partner.deliver(new DeliverRequest('e2')));
        await withOverride('https://api.partner.example', () => partner.deliver(new DeliverRequest('e3')));

        expect(sentUrls()).toEqual([
            'https://api.partner.example/webhooks/deliver',
            'https://redirector.partner.example/webhooks/deliver',
            'https://api.partner.example/webhooks/deliver',
        ]);
    });

    it('never mutates the client: a call with NO override in scope refuses rather than reusing the last one', async () => {
        const partner = partnerClient();
        await withOverride('https://api.partner.example', () => partner.deliver(new DeliverRequest('e1')));

        // A second call OUTSIDE any override scope must not inherit the first one's destination.
        await expect(RequestContext.run(() => partner.deliver(new DeliverRequest('e2')))).rejects.toThrow(
            /OVERRIDE_BASE_URL/,
        );
        expect(sent).toHaveLength(1);
    });

    it('refuses an endpoint whose auth mode mints a credential for an audience we choose', () => {
        expect(() =>
            client(OidcApi, new ClientConfig('partner', new RuntimeHostFromContext(publicDns())), []),
        ).toThrow(/cannot be used by a runtime-host client/);
    });
});

describe('a client with NO override configured behaves exactly as before', () => {
    beforeEach(() => {
        ClientRegistry.addUrlMapping('server2', 'https://server2.example');
    });

    it('resolves through ClientRegistry and ignores an ambient OVERRIDE_BASE_URL', async () => {
        const deployed = client(PartnerWebhookApi, new ClientConfig('server2', new DeployedServiceHost()), []);

        // The key IS set — this is the fan-out hazard: a delivery loop sets it, then calls some
        // OTHER client. A deployed-service client must not be re-pointed at the partner's server.
        await withOverride('https://api.partner.example', () => deployed.deliver(new DeliverRequest('e1')));

        expect(sent[0].url).toBe('https://server2.example/webhooks/deliver');
    });

    it('installs no filters at all, so nothing new runs on the deployed path', async () => {
        const deployed = client(PartnerWebhookApi, new ClientConfig('server2', new DeployedServiceHost()), []);
        await RequestContext.run(() => deployed.deliver(new DeliverRequest('e1')));

        expect(sent).toHaveLength(1);
        expect(sent[0].url).toBe('https://server2.example/webhooks/deliver');
        // 'follow' is the platform default: the deployed path never touches redirect handling, and
        // never resolves DNS — its FakeAddressResolver would have thrown if the guard had run.
        const call = vi.mocked(fetch).mock.calls[0];
        expect((call[1] as RequestInit).redirect).toBe('follow');
    });
});

describe('the SSRF policy, on by default', () => {
    // Each row is [what it is, the url]. Every one of them is a destination a partner could put in
    // their webhook row, and every one of them must be refused before any bytes leave.
    const blocked: ReadonlyArray<readonly [string, string]> = [
        ['loopback by name', 'https://localhost'],
        ['loopback by address', 'https://127.0.0.1'],
        ['IPv6 loopback', 'https://[::1]'],
        ['RFC1918 10/8', 'https://10.1.2.3'],
        ['RFC1918 172.16/12', 'https://172.20.0.9'],
        ['RFC1918 192.168/16', 'https://192.168.1.1'],
        ['link-local', 'https://169.254.1.1'],
        ['CLOUD METADATA by address', 'https://169.254.169.254'],
        ['CLOUD METADATA by name', 'https://metadata.google.internal'],
        ['carrier-grade NAT', 'https://100.64.0.1'],
        ['IPv4-mapped IPv6 loopback', 'https://[::ffff:127.0.0.1]'],
        ['IPv6 unique-local', 'https://[fd00::1]'],
    ];

    for (const row of blocked) {
        it(`refuses ${row[0]}`, async () => {
            await expect(
                withOverride(row[1], () => partnerClient().deliver(new DeliverRequest('e1'))),
            ).rejects.toBeInstanceOf(SsrfRefusedError);
            expect(sent).toHaveLength(0);
        });
    }

    it('refuses plaintext http even to a public host', async () => {
        await expect(
            withOverride('http://api.partner.example', () => partnerClient().deliver(new DeliverRequest('e1'))),
        ).rejects.toThrow(/scheme 'http:' is not allowed/);
        expect(sent).toHaveLength(0);
    });

    it('refuses a host that resolves to BOTH a public and a private address (DNS rebinding)', async () => {
        await expect(
            withOverride('https://rebind.partner.example', () => partnerClient().deliver(new DeliverRequest('e1'))),
        ).rejects.toThrow(/10\.0\.0\.5/);
        expect(sent).toHaveLength(0);
    });

    it('allows a public https host', async () => {
        await withOverride('https://api.partner.example', () =>
            partnerClient().deliver(new DeliverRequest('e1')),
        );
        expect(sent).toHaveLength(1);
    });

    it('names the ONE opt-out in its refusal, so a reader does not have to go looking', async () => {
        await expect(
            withOverride('https://127.0.0.1', () => partnerClient().deliver(new DeliverRequest('e1'))),
        ).rejects.toThrow(/RuntimeHostFromContextAllowingInternalAddresses/);
    });

    it('the named opt-out reaches an internal address, and only when named', async () => {
        const local = client(
            PartnerWebhookApi,
            new ClientConfig(
                'local-emulator',
                new RuntimeHostFromContextAllowingInternalAddresses('local emulator in tests', publicDns()),
            ),
            [],
        );

        await withOverride('http://127.0.0.1:9123', () => local.deliver(new DeliverRequest('e1')));

        expect(sent[0].url).toBe('http://127.0.0.1:9123/webhooks/deliver');
    });
});

describe('the SSRF policy and redirects', () => {
    it('refuses a redirect INTO an internal address, having sent nothing further', async () => {
        stubTransport([redirectTo('http://169.254.169.254/computeMetadata/v1/'), ok()]);

        await expect(
            withOverride('https://redirector.partner.example', () =>
                partnerClient().deliver(new DeliverRequest('e1')),
            ),
        ).rejects.toBeInstanceOf(SsrfRefusedError);

        // The first hop went out; the metadata hop did NOT.
        expect(sentUrls()).toEqual(['https://redirector.partner.example/webhooks/deliver']);
    });

    it('does not let the transport follow redirects on its own', async () => {
        await withOverride('https://api.partner.example', () =>
            partnerClient().deliver(new DeliverRequest('e1')),
        );
        // The guard took redirect handling away from the transport so it can judge each hop itself.
        const call = vi.mocked(fetch).mock.calls[0];
        expect((call[1] as RequestInit).redirect).toBe('manual');
    });

    it('follows ONE redirect to a public host, re-judged under the same policy', async () => {
        stubTransport([redirectTo('https://api.partner.example/moved'), ok()]);

        await withOverride('https://redirector.partner.example', () =>
            partnerClient().deliver(new DeliverRequest('e1')),
        );

        expect(sentUrls()).toEqual([
            'https://redirector.partner.example/webhooks/deliver',
            'https://api.partner.example/moved',
        ]);
    });

    it('refuses a redirect chain longer than the policy allows', async () => {
        stubTransport([
            redirectTo('https://api.partner.example/one'),
            redirectTo('https://api.partner.example/two'),
        ]);

        await expect(
            withOverride('https://redirector.partner.example', () =>
                partnerClient().deliver(new DeliverRequest('e1')),
            ),
        ).rejects.toThrow(/refused to follow more than 1 redirect/);
    });
});

/** Signs the EXACT bytes it is handed, and records them so the test can compare with the wire. */
class RecordingSigningFilter extends Filter<ClientRequest, Response> {
    signedBytes: string | undefined;
    signedUrl: string | undefined;

    override async filter(request: ClientRequest, nextFilter: Service<ClientRequest, Response>): Promise<Response> {
        this.signedBytes = request.body;
        this.signedUrl = request.url;
        request.headers.set('x-signature', `sha256=${(request.body ?? '').length}`);
        return nextFilter.invoke(request);
    }
}

/** Replaces the body outright, to prove the transport sends what the chain left behind. */
class RewritingFilter extends Filter<ClientRequest, Response> {
    override async filter(request: ClientRequest, nextFilter: Service<ClientRequest, Response>): Promise<Response> {
        request.body = '{"rewritten":true}';
        return nextFilter.invoke(request);
    }
}

/** Appends its name to a shared list when it runs, so ordering is observable. */
class OrderRecordingFilter extends Filter<ClientRequest, Response> {
    constructor(
        private readonly label: string,
        private readonly order: string[],
    ) {
        super();
    }

    override async filter(request: ClientRequest, nextFilter: Service<ClientRequest, Response>): Promise<Response> {
        this.order.push(`${this.label}-in`);
        const response = await nextFilter.invoke(request);
        this.order.push(`${this.label}-out`);
        return response;
    }
}

describe('app filters', () => {
    it('a signing filter sees the EXACT bytes that are transmitted', async () => {
        const signer = new RecordingSigningFilter();
        await withOverride('https://api.partner.example', () =>
            partnerClient([new ClientFilterDefinition(500, signer)]).deliver(new DeliverRequest('e1')),
        );

        // This is the whole point of part 4: sign-time bytes === wire bytes, byte for byte. A client
        // that re-serialized internally would sign one sequence and send another.
        expect(signer.signedBytes).toBe(JSON.stringify(new DeliverRequest('e1')));
        expect(sent[0].body).toBe(signer.signedBytes);
        expect(sent[0].headers['x-signature']).toBe(`sha256=${signer.signedBytes?.length}`);
    });

    it('a body a filter REPLACES is the body that is sent', async () => {
        await withOverride('https://api.partner.example', () =>
            partnerClient([new ClientFilterDefinition(500, new RewritingFilter())]).deliver(
                new DeliverRequest('e1'),
            ),
        );

        expect(sent[0].body).toBe('{"rewritten":true}');
    });

    it('a signing filter signs for the host the call ACTUALLY goes to', async () => {
        const signer = new RecordingSigningFilter();
        await withOverride('https://api.partner.example', () =>
            partnerClient([new ClientFilterDefinition(500, signer)]).deliver(new DeliverRequest('e1')),
        );
        expect(signer.signedUrl).toBe('https://api.partner.example/webhooks/deliver');
    });

    it('runs filters in PRIORITY order, highest outermost', async () => {
        const order: string[] = [];
        await withOverride('https://api.partner.example', () =>
            partnerClient([
                new ClientFilterDefinition(100, new OrderRecordingFilter('low', order)),
                new ClientFilterDefinition(700, new OrderRecordingFilter('high', order)),
                new ClientFilterDefinition(400, new OrderRecordingFilter('mid', order)),
            ]).deliver(new DeliverRequest('e1')),
        );

        expect(order).toEqual(['high-in', 'mid-in', 'low-in', 'low-out', 'mid-out', 'high-out']);
    });

    it('an app filter runs INSIDE the framework built-ins, so it sees the settled destination', async () => {
        const order: string[] = [];
        const signer = new RecordingSigningFilter();
        // 999 is below BASE_URL_OVERRIDE_PRIORITY (1000) but above SSRF_GUARD_PRIORITY (900).
        await withOverride('https://api.partner.example', () =>
            partnerClient([
                new ClientFilterDefinition(999, new OrderRecordingFilter('app', order)),
                new ClientFilterDefinition(500, signer),
            ]).deliver(new DeliverRequest('e1')),
        );

        expect(order).toEqual(['app-in', 'app-out']);
        expect(signer.signedUrl).toBe('https://api.partner.example/webhooks/deliver');
    });
});
