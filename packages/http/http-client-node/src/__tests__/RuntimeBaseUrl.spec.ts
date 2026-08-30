import 'reflect-metadata';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    ApiCallContextHolder,
    ApiPath,
    AuthOidc,
    AuthSharedSecret,
    AuthWebhook,
    ClientRegistry,
    DestinationTrust,
    Endpoint,
    Filter,
    Public,
    Rpc,
    Secrets,
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
import { ContextBaseUrlFilter } from '../ContextBaseUrlFilter';
import { NodeProxyClient } from '../NodeProxyClient';
import { SsrfPolicy } from '../SsrfPolicy';
import { SsrfRefusedError } from '../SsrfRefusedError';
import { MissingRuntimeBaseUrlError } from '../MissingRuntimeBaseUrlError';
import { SignableRequest, WebhookSignerCallback } from '../WebhookSignerCallback';

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

/**
 * The regression #719 introduced and this change removes: an endpoint whose credential is minted for
 * an audience, called against a URL that arrives per call. Dean's case — N services implementing ONE
 * contract, all behind ONE agreed secret — is exactly this, and banning it was wrong.
 */
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

@Rpc()
@ApiPath('/internal')
abstract class SharedSecretApi {
    @Endpoint('/work', 'rpc')
    @AuthSharedSecret('partner-secret')
    // webpieces-disable no-unmanaged-exceptions -- abstract contract stub, never executed
    work(_request: DeliverRequest): Promise<void> {
        throw new Error('contract only');
    }
}

/** WE are the vendor on this one: the partner verifies the signature our signer produces. */
@Rpc()
@ApiPath('/ot-webhook')
abstract class SignedWebhookApi {
    @Endpoint('/deliver', 'rpc')
    @AuthWebhook('partner-hmac')
    // webpieces-disable no-unmanaged-exceptions -- abstract contract stub, never executed
    deliver(_request: DeliverRequest): Promise<void> {
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

/** Records the audience it was asked to mint for, so a test can check WHICH url won. */
class StubOidc {
    audiences: string[] = [];

    mintIdToken(audience: string): Promise<string> {
        this.audiences.push(audience);
        return Promise.resolve(`token-for-${audience}`);
    }
}

class StubSecrets {
    get(key: string): string | undefined {
        return key === 'partner-secret' ? 's3cret' : undefined;
    }
}

/** Records exactly what it was handed to sign, so a test can compare with the wire. */
class RecordingWebhookSigner extends WebhookSignerCallback {
    signedName: string | undefined;
    signed: SignableRequest | undefined;

    override async sign(name: string, request: SignableRequest): Promise<Map<string, string>> {
        this.signedName = name;
        this.signed = request;
        return new Map([['x-partner-signature', `v1=${(request.body ?? '').length}:${request.url}`]]);
    }
}

/** An AddressResolver that answers from a table, so the policy is testable with no DNS. */
class FakeAddressResolver extends AddressResolver {
    resolved: string[] = [];

    constructor(private readonly answers: Map<string, string[]>) {
        super();
    }

    override async resolve(hostname: string): Promise<string[]> {
        this.resolved.push(hostname);
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

/** Everything a NodeProxyClient is normally handed by the container, as test doubles. */
class Doubles {
    readonly oidc = new StubOidc();
    readonly dns = publicDns();

    constructor(readonly signer: WebhookSignerCallback | undefined = undefined) {}
}

/** A real NodeProxyClient bound to a contract, behind the same Proxy the factory would build. */
function client<T extends object>(
    api: ApiPrototype<T>,
    config: ClientConfig,
    filters: ClientFilterDefinition[],
    doubles: Doubles = new Doubles(),
): T {
    const proxyClient = new NodeProxyClient(
        // webpieces-disable no-any-unknown -- test double: only buildOutboundHeaders/findRecorder are reached
        new StubHeaders() as unknown as RequestContextHeaders,
        // webpieces-disable no-any-unknown -- test double: only mintIdToken is reached
        doubles.oidc as unknown as GcpOidc,
        doubles.dns,
        // webpieces-disable no-any-unknown -- test double: only get() is reached
        new StubSecrets() as unknown as Secrets,
        doubles.signer,
    );
    proxyClient.init(api, config, filters);
    return buildClientProxy(api, proxyClient);
}

/** The target shape: one filter, no second ClientConfig argument, nothing else. */
function partnerClient(filters: ClientFilterDefinition[] = [], doubles: Doubles = new Doubles()): PartnerWebhookApi {
    return client(
        PartnerWebhookApi,
        new ClientConfig('partner-webhooks'),
        [new ClientFilterDefinition(1000, new ContextBaseUrlFilter()), ...filters],
        doubles,
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
    ClientRegistry.addUrlMapping('server2', 'https://server2.example');
    // A re-pointed client still HAS a configured address; the point is that it never uses it.
    ClientRegistry.addUrlMapping('partner-webhooks', 'https://unused.example');
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('the runtime base-URL override, as ONE app filter', () => {
    it('sends ONE call to the url the context supplied', async () => {
        await withOverride('https://api.partner.example', () => partnerClient().deliver(new DeliverRequest('e1')));

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

        // A second call OUTSIDE any override scope must not inherit the first one's destination, and
        // must not fall back to this client's own registry URL either. Its OWN type, not a bare
        // Error: a delivery worker must tell "we were misconfigured" from "the partner's URL was
        // hostile" (SsrfRefusedError) — different owners, different cures.
        await expect(RequestContext.run(() => partner.deliver(new DeliverRequest('e2')))).rejects.toBeInstanceOf(
            MissingRuntimeBaseUrlError,
        );
        await expect(RequestContext.run(() => partner.deliver(new DeliverRequest('e2')))).rejects.toThrow(
            /OVERRIDE_BASE_URL/,
        );
        expect(sent).toHaveLength(1);
    });
});

describe('a client with NO ContextBaseUrlFilter', () => {
    it('resolves through ClientRegistry and IGNORES an ambient OVERRIDE_BASE_URL', async () => {
        const deployed = client(PartnerWebhookApi, new ClientConfig('server2'), []);

        // The key IS set — this is the fan-out hazard: a delivery loop sets it, then calls some
        // OTHER client. A client that never installed the filter must not be re-pointed.
        await withOverride('https://api.partner.example', () => deployed.deliver(new DeliverRequest('e1')));

        expect(sent[0].url).toBe('https://server2.example/webhooks/deliver');
    });

    it('is not SSRF-checked at all: no DNS, and the transport keeps its own redirect handling', async () => {
        const doubles = new Doubles();
        const deployed = client(PartnerWebhookApi, new ClientConfig('server2'), [], doubles);
        await RequestContext.run(() => deployed.deliver(new DeliverRequest('e1')));

        expect(sentUrls()).toEqual(['https://server2.example/webhooks/deliver']);
        // A ClientRegistry-resolved URL is an address WE chose, so the guard steps aside entirely.
        expect(doubles.dns.resolved).toEqual([]);
        const call = vi.mocked(fetch).mock.calls[0];
        expect((call[1] as RequestInit).redirect).toBe('follow');
    });

    it('reaches a localhost emulator with no opt-out of any kind, because the registry is not judged', async () => {
        ClientRegistry.addUrlMapping('local-svc', 'http://localhost:8202');
        const local = client(PartnerWebhookApi, new ClientConfig('local-svc'), []);

        await RequestContext.run(() => local.deliver(new DeliverRequest('e1')));

        expect(sent[0].url).toBe('http://localhost:8202/webhooks/deliver');
    });
});

describe('the SSRF policy, armed by the ACT of re-pointing', () => {
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
        ['IPv4-mapped IPv6 loopback, dotted', 'https://[::ffff:127.0.0.1]'],
        // The hole #719 found and closed: the SAME address written in hex. A rule matching only the
        // dotted spelling waved this straight through.
        ['IPv4-mapped IPv6 loopback, HEX', 'https://[::ffff:7f00:1]'],
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
        await withOverride('https://api.partner.example', () => partnerClient().deliver(new DeliverRequest('e1')));
        expect(sent).toHaveLength(1);
    });

    it('names the ONE opt-out in its refusal, so a reader does not have to go looking', async () => {
        await expect(
            withOverride('https://127.0.0.1', () => partnerClient().deliver(new DeliverRequest('e1'))),
        ).rejects.toThrow(/SsrfPolicy\.forTesting/);
    });

    it('the named opt-out reaches an internal address, and only when named', async () => {
        const local = client(PartnerWebhookApi, new ClientConfig('partner-webhooks'), [
            new ClientFilterDefinition(
                1000,
                new ContextBaseUrlFilter(SsrfPolicy.forTesting('exercising the partner path against a local fake')),
            ),
        ]);

        await withOverride('http://127.0.0.1:9123', () => local.deliver(new DeliverRequest('e1')));

        expect(sent[0].url).toBe('http://127.0.0.1:9123/webhooks/deliver');
    });
});

describe('the SSRF policy and redirects', () => {
    it('refuses a redirect INTO an internal address, having sent nothing further', async () => {
        stubTransport([redirectTo('http://169.254.169.254/computeMetadata/v1/'), ok()]);

        await expect(
            withOverride('https://redirector.partner.example', () => partnerClient().deliver(new DeliverRequest('e1'))),
        ).rejects.toBeInstanceOf(SsrfRefusedError);

        // The first hop went out; the metadata hop did NOT.
        expect(sentUrls()).toEqual(['https://redirector.partner.example/webhooks/deliver']);
    });

    it('does not let the transport follow redirects on its own', async () => {
        await withOverride('https://api.partner.example', () => partnerClient().deliver(new DeliverRequest('e1')));
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
        stubTransport([redirectTo('https://api.partner.example/one'), redirectTo('https://api.partner.example/two')]);

        await expect(
            withOverride('https://redirector.partner.example', () => partnerClient().deliver(new DeliverRequest('e1'))),
        ).rejects.toThrow(/refused to follow more than 1 redirect/);
    });
});

describe('outbound auth against a re-pointed URL', () => {
    it('@AuthOidc WORKS, and mints for the FINAL destination — not the configured one', async () => {
        // The regression #719 introduced: this combination used to throw at BIND time. It is
        // legitimate — N services implementing one contract, each authenticating us by OIDC — and
        // the audience has to be the url we are ACTUALLY talking to, which is why the minter moved
        // into the chain.
        const doubles = new Doubles();
        const oidcClient = client(
            OidcApi,
            new ClientConfig('partner-webhooks'),
            [new ClientFilterDefinition(1000, new ContextBaseUrlFilter())],
            doubles,
        );

        await withOverride('https://api.partner.example', () => oidcClient.work(new DeliverRequest('e1')));

        expect(doubles.oidc.audiences).toEqual(['https://api.partner.example']);
        expect(sent[0].headers['Authorization']).toBe('Bearer token-for-https://api.partner.example');
    });

    it('@AuthSharedSecret WORKS — N services behind ONE agreed secret is a real topology', async () => {
        const secretClient = client(SharedSecretApi, new ClientConfig('partner-webhooks'), [
            new ClientFilterDefinition(1000, new ContextBaseUrlFilter()),
        ]);

        await withOverride('https://api.partner.example', () => secretClient.work(new DeliverRequest('e1')));

        expect(sent[0].url).toBe('https://api.partner.example/internal/work');
        expect(sent[0].headers['Authorization']).toBe('Webpieces s3cret');
    });

    it('mints AFTER the SSRF guard has judged the destination, so a refused url never gets a token', async () => {
        const doubles = new Doubles();
        const oidcClient = client(
            OidcApi,
            new ClientConfig('partner-webhooks'),
            [new ClientFilterDefinition(1000, new ContextBaseUrlFilter())],
            doubles,
        );

        await expect(
            withOverride('https://169.254.169.254', () => oidcClient.work(new DeliverRequest('e1'))),
        ).rejects.toBeInstanceOf(SsrfRefusedError);

        // No credential was ever created for the metadata server.
        expect(doubles.oidc.audiences).toEqual([]);
    });
});

describe('@AuthWebhook, outbound — WE are the vendor', () => {
    it('hands the signer the FINAL url and the EXACT bytes that are transmitted', async () => {
        const signer = new RecordingWebhookSigner();
        const signedClient = client(
            SignedWebhookApi,
            new ClientConfig('partner-webhooks'),
            [new ClientFilterDefinition(1000, new ContextBaseUrlFilter())],
            new Doubles(signer),
        );

        await withOverride('https://api.partner.example', () => signedClient.deliver(new DeliverRequest('e1')));

        expect(signer.signedName).toBe('partner-hmac');
        expect(signer.signed?.url).toBe('https://api.partner.example/ot-webhook/deliver');
        expect(signer.signed?.httpMethod).toBe('POST');
        expect(signer.signed?.contractName).toBe('SignedWebhookApi');
        expect(signer.signed?.methodName).toBe('deliver');
        // Sign-time bytes === wire bytes, byte for byte. A client that re-serialized internally
        // would sign one sequence and send another, and the failure would be silent.
        expect(signer.signed?.body).toBe(JSON.stringify(new DeliverRequest('e1')));
        expect(sent[0].body).toBe(signer.signed?.body);
        expect(sent[0].headers['x-partner-signature']).toBe(
            `v1=${signer.signed?.body?.length}:https://api.partner.example/ot-webhook/deliver`,
        );
    });

    it('FAILS CLOSED with no signer bound — it does not deliver unsigned', async () => {
        const unsigned = client(
            SignedWebhookApi,
            new ClientConfig('partner-webhooks'),
            [new ClientFilterDefinition(1000, new ContextBaseUrlFilter())],
            new Doubles(undefined),
        );

        await expect(
            withOverride('https://api.partner.example', () => unsigned.deliver(new DeliverRequest('e1'))),
        ).rejects.toThrow(/no WebhookSignerCallback is bound/);
        expect(sent).toHaveLength(0);
    });

    it('is callable at all — binding the client no longer throws for @AuthWebhook', () => {
        expect(() =>
            client(
                SignedWebhookApi,
                new ClientConfig('partner-webhooks'),
                [],
                new Doubles(new RecordingWebhookSigner()),
            ),
        ).not.toThrow();
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

/** Re-points the request from INSIDE the chain, which is what an app filter can legally do. */
class LateRePointingFilter extends Filter<ClientRequest, Response> {
    constructor(private readonly target: string) {
        super();
    }

    override async filter(request: ClientRequest, nextFilter: Service<ClientRequest, Response>): Promise<Response> {
        request.pointAtBaseUrl(this.target);
        return nextFilter.invoke(request);
    }
}

describe('app filters', () => {
    it('a signing filter sees the EXACT bytes that are transmitted', async () => {
        const signer = new RecordingSigningFilter();
        await withOverride('https://api.partner.example', () =>
            partnerClient([new ClientFilterDefinition(500, signer)]).deliver(new DeliverRequest('e1')),
        );

        expect(signer.signedBytes).toBe(JSON.stringify(new DeliverRequest('e1')));
        expect(sent[0].body).toBe(signer.signedBytes);
        expect(sent[0].headers['x-signature']).toBe(`sha256=${signer.signedBytes?.length}`);
    });

    it('a body a filter REPLACES is the body that is sent', async () => {
        await withOverride('https://api.partner.example', () =>
            partnerClient([new ClientFilterDefinition(500, new RewritingFilter())]).deliver(new DeliverRequest('e1')),
        );

        expect(sent[0].body).toBe('{"rewritten":true}');
    });

    it('a filter sees the host the call ACTUALLY goes to', async () => {
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

    it('CANNOT displace the built-ins, however extreme a priority it types', async () => {
        // A url rewriter at the LOWEST priority an app can express still runs ABOVE the SSRF guard,
        // because the built-ins are ordered structurally, not numerically. So its hostile
        // destination is caught rather than obeyed.
        const doubles = new Doubles();
        const rewriter = client(
            OidcApi,
            new ClientConfig('partner-webhooks'),
            [
                new ClientFilterDefinition(Number.MAX_SAFE_INTEGER, new ContextBaseUrlFilter()),
                new ClientFilterDefinition(Number.MIN_SAFE_INTEGER, new LateRePointingFilter('https://169.254.169.254')),
            ],
            doubles,
        );

        await expect(
            withOverride('https://api.partner.example', () => rewriter.work(new DeliverRequest('e1'))),
        ).rejects.toBeInstanceOf(SsrfRefusedError);
        expect(sent).toHaveLength(0);
        expect(doubles.oidc.audiences).toEqual([]);
    });

    it('the built-ins see what the LAST app filter left behind, not what the first one did', async () => {
        const doubles = new Doubles();
        const rewriter = client(
            OidcApi,
            new ClientConfig('partner-webhooks'),
            [
                new ClientFilterDefinition(1000, new ContextBaseUrlFilter()),
                new ClientFilterDefinition(1, new LateRePointingFilter('https://redirector.partner.example')),
            ],
            doubles,
        );

        await withOverride('https://api.partner.example', () => rewriter.work(new DeliverRequest('e1')));

        expect(sent[0].url).toBe('https://redirector.partner.example/internal/work');
        expect(doubles.oidc.audiences).toEqual(['https://redirector.partner.example']);
    });
});
