import 'reflect-metadata';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    ApiPath,
    ClientRegistry,
    DestinationTrust,
    Endpoint,
    QueryParam,
    Rpc,
    Secrets,
    TestCaseRecorder,
    WebpiecesCoreHeaders,
    WpAuthOidc,
    WpAuthPublic,
    POST,
    RPC,
    WRITE,
} from '@webpieces/core-util';
import type { RequestContextHeaders } from '@webpieces/core-context';
import { RequestContext } from '@webpieces/core-context';
import type { GcpOidc } from '@webpieces/gcp-identity';
import type { ApiPrototype } from '@webpieces/http-client-core';
import { buildClientProxy, ClientFilterDefinition } from '@webpieces/http-client-core';
import { AddressResolver } from '../AddressResolver';
import { ClientConfig } from '../ClientConfig';
import { ContextBaseUrlFilter } from '../ContextBaseUrlFilter';
import { ContextFullUrlFilter } from '../ContextFullUrlFilter';
import { MissingRuntimeBaseUrlError } from '../MissingRuntimeBaseUrlError';
import { NodeProxyClient } from '../NodeProxyClient';
import { SsrfTestingPolicy } from '../SsrfPolicy';
import { SsrfRefusedError } from '../SsrfRefusedError';

class DeliverRequest {
    constructor(public readonly eventId: string) {}
}

/** An HONEST contract path, which the full-URL override must NOT append. */
@Rpc()
@ApiPath('/webhook')
abstract class HonestWebhookApi {
    @Endpoint(POST, '/deliver', WRITE, RPC)
    @WpAuthPublic('Partner authenticates us by signature')
    // webpieces-disable no-unmanaged-exceptions -- abstract contract stub, never executed
    deliver(_request: DeliverRequest): Promise<void> {
        throw new Error('contract only');
    }

    @Endpoint(POST, '/deliver-tagged', WRITE, RPC)
    @WpAuthPublic('Partner authenticates us by signature')
    // webpieces-disable no-unmanaged-exceptions -- abstract contract stub, never executed
    deliverTagged(@QueryParam('tag') _tag: string, _request: DeliverRequest): Promise<void> {
        throw new Error('contract only');
    }
}

/** The pre-#926 workaround shape: empty paths, so base + '' + '' is the base URL. */
@Rpc()
@ApiPath('')
abstract class EmptyPathWebhookApi {
    @Endpoint(POST, '', WRITE, RPC)
    @WpAuthPublic('Partner authenticates us by signature')
    // webpieces-disable no-unmanaged-exceptions -- abstract contract stub, never executed
    deliver(_request: DeliverRequest): Promise<void> {
        throw new Error('contract only');
    }
}

@Rpc()
@ApiPath('/internal')
abstract class OidcWebhookApi {
    @Endpoint(POST, '/work', WRITE, RPC)
    @WpAuthOidc()
    // webpieces-disable no-unmanaged-exceptions -- abstract contract stub, never executed
    work(_request: DeliverRequest): Promise<void> {
        throw new Error('contract only');
    }
}

/** Two endpoints on one method + path: refused when the client binds. */
@Rpc()
@ApiPath('')
abstract class DuplicateRouteApi {
    @Endpoint(POST, '', WRITE, RPC)
    @WpAuthPublic('Test fixture')
    // webpieces-disable no-unmanaged-exceptions -- abstract contract stub, never executed
    deliver(_request: DeliverRequest): Promise<void> {
        throw new Error('contract only');
    }

    @Endpoint(POST, '', WRITE, RPC)
    @WpAuthPublic('Test fixture')
    // webpieces-disable no-unmanaged-exceptions -- abstract contract stub, never executed
    redeliver(_request: DeliverRequest): Promise<void> {
        throw new Error('contract only');
    }
}

class StubHeaders {
    buildOutboundHeaders(_destination: DestinationTrust): Map<string, string> {
        return new Map<string, string>();
    }

    /**
     * The RESPONSE half of the same seam, no-op here: these specs assert on the REQUEST the client
     * built, and the context-transfer of response keys is covered in core-context's
     * `ResponseContext.spec.ts`.
     */
    acceptResponseHeaders(_headers: Headers, _destination: DestinationTrust): void {}

    findRecorder(): TestCaseRecorder | undefined {
        return undefined;
    }
}

class StubOidc {
    audiences: string[] = [];

    mintIdToken(audience: string): Promise<string> {
        this.audiences.push(audience);
        return Promise.resolve(`token-for-${audience}`);
    }
}

class StubSecrets {
    get(_key: string): string | undefined {
        return undefined;
    }
}

/** Answers DNS from a table and records every lookup, so "the guard ran" is observable. */
class FakeAddressResolver extends AddressResolver {
    resolved: string[] = [];

    override async resolve(hostname: string): Promise<string[]> {
        this.resolved.push(hostname);
        if (hostname === 'internal.partner.example') return ['10.0.0.5'];
        return ['93.184.216.34'];
    }
}

class Doubles {
    readonly oidc = new StubOidc();
    readonly dns = new FakeAddressResolver();
}

let sentUrls: string[] = [];

function client<T extends object>(
    api: ApiPrototype<T>,
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
        undefined,
    );
    proxyClient.init(api, new ClientConfig('partner-webhooks'), filters);
    return buildClientProxy(api, proxyClient);
}

function fullUrlFilter(): ClientFilterDefinition[] {
    return [new ClientFilterDefinition(1000, new ContextFullUrlFilter())];
}

function withContext<T>(
    key: typeof WebpiecesCoreHeaders.OVERRIDE_FULL_URL,
    url: string,
    fn: () => Promise<T>,
): Promise<T> {
    return RequestContext.run(() => {
        RequestContext.putUntrusted(key, url);
        return fn();
    });
}

const STORED_URL = 'https://api.partner.example/hooks/in/abc123?token=xyz&v=2';

beforeEach(() => {
    sentUrls = [];
    vi.stubGlobal(
        'fetch',
        vi.fn((url: string) => {
            sentUrls.push(url);
            return Promise.resolve(
                new Response(JSON.stringify({}), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }),
            );
        }),
    );
    // Configured, and never used: a re-pointed client must not fall back to it.
    ClientRegistry.addUrlMapping('partner-webhooks', 'https://unused.example');
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('ContextFullUrlFilter + OVERRIDE_FULL_URL', () => {
    it('sends to the stored url byte for byte: path and query kept, contract path NOT appended', async () => {
        const partner = client(HonestWebhookApi, fullUrlFilter());

        await withContext(WebpiecesCoreHeaders.OVERRIDE_FULL_URL, STORED_URL, () =>
            partner.deliver(new DeliverRequest('e1')),
        );

        expect(sentUrls).toEqual([STORED_URL]);
    });

    it('does not add a separator or the contract query to a url with no path', async () => {
        const partner = client(HonestWebhookApi, fullUrlFilter());

        await withContext(
            WebpiecesCoreHeaders.OVERRIDE_FULL_URL,
            'https://api.partner.example',
            () => partner.deliverTagged('blue', new DeliverRequest('e1')),
        );

        expect(sentUrls).toEqual(['https://api.partner.example']);
    });

    it('does not leak between calls on one client', async () => {
        const partner = client(HonestWebhookApi, fullUrlFilter());
        const second = 'https://api.partner.example/other?x=1';

        await withContext(WebpiecesCoreHeaders.OVERRIDE_FULL_URL, STORED_URL, () =>
            partner.deliver(new DeliverRequest('e1')),
        );
        await withContext(WebpiecesCoreHeaders.OVERRIDE_FULL_URL, second, () =>
            partner.deliver(new DeliverRequest('e2')),
        );

        expect(sentUrls).toEqual([STORED_URL, second]);
    });

    it('REFUSES with no override in scope, naming OVERRIDE_FULL_URL, and never uses the configured url', async () => {
        const partner = client(HonestWebhookApi, fullUrlFilter());

        await expect(
            RequestContext.run(() => partner.deliver(new DeliverRequest('e1'))),
        ).rejects.toBeInstanceOf(MissingRuntimeBaseUrlError);
        await expect(
            RequestContext.run(() => partner.deliver(new DeliverRequest('e1'))),
        ).rejects.toThrow(/OVERRIDE_FULL_URL/);
        expect(sentUrls).toEqual([]);
    });

    it('ignores OVERRIDE_BASE_URL: the full-url filter reads only its own key', async () => {
        const partner = client(HonestWebhookApi, fullUrlFilter());

        await expect(
            RequestContext.run(() => {
                RequestContext.putUntrusted(
                    WebpiecesCoreHeaders.OVERRIDE_BASE_URL,
                    'https://api.partner.example',
                );
                return partner.deliver(new DeliverRequest('e1'));
            }),
        ).rejects.toBeInstanceOf(MissingRuntimeBaseUrlError);
        expect(sentUrls).toEqual([]);
    });

    it('a client WITHOUT the filter ignores an ambient OVERRIDE_FULL_URL', async () => {
        const deployed = client(HonestWebhookApi, []);

        await withContext(WebpiecesCoreHeaders.OVERRIDE_FULL_URL, STORED_URL, () =>
            deployed.deliver(new DeliverRequest('e1')),
        );

        expect(sentUrls).toEqual(['https://unused.example/webhook/deliver']);
    });
});

describe('ContextFullUrlFilter arms the SSRF guard', () => {
    it('judges the stored url: DNS is resolved for its host', async () => {
        const doubles = new Doubles();
        const partner = client(HonestWebhookApi, fullUrlFilter(), doubles);

        await withContext(WebpiecesCoreHeaders.OVERRIDE_FULL_URL, STORED_URL, () =>
            partner.deliver(new DeliverRequest('e1')),
        );

        expect(doubles.dns.resolved).toEqual(['api.partner.example']);
        const call = vi.mocked(fetch).mock.calls[0];
        expect((call[1] as RequestInit).redirect).toBe('manual');
    });

    it('refuses an internal address before any bytes leave', async () => {
        const partner = client(HonestWebhookApi, fullUrlFilter());

        await expect(
            withContext(
                WebpiecesCoreHeaders.OVERRIDE_FULL_URL,
                'https://169.254.169.254/computeMetadata/v1/',
                () => partner.deliver(new DeliverRequest('e1')),
            ),
        ).rejects.toBeInstanceOf(SsrfRefusedError);
        await expect(
            withContext(
                WebpiecesCoreHeaders.OVERRIDE_FULL_URL,
                'https://internal.partner.example/in?x=1',
                () => partner.deliver(new DeliverRequest('e1')),
            ),
        ).rejects.toThrow(/10\.0\.0\.5/);
        expect(sentUrls).toEqual([]);
    });

    it('refuses plaintext http', async () => {
        const partner = client(HonestWebhookApi, fullUrlFilter());

        await expect(
            withContext(
                WebpiecesCoreHeaders.OVERRIDE_FULL_URL,
                'http://api.partner.example/in',
                () => partner.deliver(new DeliverRequest('e1')),
            ),
        ).rejects.toThrow(/scheme 'http:' is not allowed/);
    });

    it('takes its SSRF policy from the ContextFullUrlFilter construction site', async () => {
        const local = client(HonestWebhookApi, [
            new ClientFilterDefinition(
                1000,
                new ContextFullUrlFilter(
                    new SsrfTestingPolicy('exercising the partner path against a local fake'),
                ),
            ),
        ]);

        await withContext(
            WebpiecesCoreHeaders.OVERRIDE_FULL_URL,
            'http://127.0.0.1:9123/in?x=1',
            () => local.deliver(new DeliverRequest('e1')),
        );

        expect(sentUrls).toEqual(['http://127.0.0.1:9123/in?x=1']);
    });

    it('mints @WpAuthOidc for the stored url origin', async () => {
        const doubles = new Doubles();
        const oidc = client(OidcWebhookApi, fullUrlFilter(), doubles);

        await withContext(WebpiecesCoreHeaders.OVERRIDE_FULL_URL, STORED_URL, () =>
            oidc.work(new DeliverRequest('e1')),
        );

        expect(doubles.oidc.audiences).toEqual(['https://api.partner.example']);
        expect(sentUrls).toEqual([STORED_URL]);
    });
});

describe('empty contract paths with ContextBaseUrlFilter (#926 regression)', () => {
    it("@ApiPath('') + @Endpoint(POST, '') sends to OVERRIDE_BASE_URL byte for byte", async () => {
        const partner = client(EmptyPathWebhookApi, [
            new ClientFilterDefinition(1000, new ContextBaseUrlFilter()),
        ]);

        await RequestContext.run(() => {
            RequestContext.putUntrusted(WebpiecesCoreHeaders.OVERRIDE_BASE_URL, STORED_URL);
            return partner.deliver(new DeliverRequest('e1'));
        });

        expect(sentUrls).toEqual([STORED_URL]);
    });
});

describe('duplicate routes', () => {
    it('refuses to bind a contract whose endpoints share an HTTP method + path, naming both', () => {
        expect(() => client(DuplicateRouteApi, [])).toThrow(
            /DuplicateRouteApi\.deliver and DuplicateRouteApi\.redeliver both resolve to POST ''/,
        );
    });
});
