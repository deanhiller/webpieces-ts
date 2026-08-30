import 'reflect-metadata';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    ApiCallContextHolder,
    ApiPath,
    ClientRegistry,
    DestinationTrust,
    Endpoint,
    Filter,
    Public,
    Rpc,
    Secrets,
    Service,
    TestCaseRecorder,
} from '@webpieces/core-util';
import type { AnyUntrustedContextKey, ApiCallContext } from '@webpieces/core-util';
import type { RequestContextHeaders } from '@webpieces/core-context';
import { Provider, RequestContext } from '@webpieces/core-context';
import type { GcpOidc } from '@webpieces/gcp-identity';
import { ClientFilterDefinition, ClientRequest } from '@webpieces/http-client-core';
import { AddressResolver } from '../AddressResolver';
import { ClientConfig } from '../ClientConfig';
import { ClientHttpFactory } from '../ClientHttpFactory';
import { NodeProxyClient } from '../NodeProxyClient';

/**
 * The RUNTIME half of the "filters are genuinely optional" change; the TYPE half is pinned in
 * `CreateRpcClientCompileAssertions.ts`, which the build compiles.
 *
 * What matters here is that the two spellings of "no app filters" — omitting the argument and
 * passing `[]` — are not merely both accepted by tsc but produce the SAME client, because
 * `createRpcClient` normalizes `undefined` to `[]` before `init` sees it. If they ever diverged,
 * making the parameter optional would have introduced the very ambiguity the tuple was guarding
 * against; they do not, so it did not.
 */

class WorkRequest {
    constructor(public readonly id: string) {}
}

@Rpc()
@ApiPath('/svc')
abstract class SvcApi {
    @Endpoint('/work', 'rpc')
    @Public()
    // webpieces-disable no-unmanaged-exceptions -- abstract contract stub, never executed
    work(_request: WorkRequest): Promise<void> {
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

class NoopApiCallContext implements ApiCallContext {
    isActive(): boolean {
        return true;
    }

    // webpieces-disable no-any-unknown -- a context value is heterogeneous; this impl records nothing
    set(_contextKey: AnyUntrustedContextKey, _value: unknown): void {}

    remove(_contextKey: AnyUntrustedContextKey): void {}
}

class StubOidc {
    mintIdToken(audience: string): Promise<string> {
        return Promise.resolve(`token-for-${audience}`);
    }
}

class StubSecrets {
    get(_key: string): string | undefined {
        return undefined;
    }
}

class FakeAddressResolver extends AddressResolver {
    override async resolve(_hostname: string): Promise<string[]> {
        return ['93.184.216.34'];
    }
}

/** An ordinary app filter with a visible effect on the wire, so a test can see it ran. */
class OutboundLogFilter extends Filter<ClientRequest, Response> {
    override filter(request: ClientRequest, next: Service<ClientRequest, Response>): Promise<Response> {
        request.headers.set('x-log', 'on');
        return next.invoke(request);
    }
}

class SentCall {
    constructor(
        public readonly url: string,
        public readonly headers: Record<string, string>,
    ) {}
}

let sent: SentCall[] = [];

function stubTransport(): void {
    vi.stubGlobal(
        'fetch',
        vi.fn((url: string, options: RequestInit) => {
            sent.push(new SentCall(url, options.headers as Record<string, string>));
            return Promise.resolve(
                new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } }),
            );
        }),
    );
}

/** The real ClientHttpFactory, handed a Provider that builds NodeProxyClients from test doubles. */
function newFactory(): ClientHttpFactory {
    return new ClientHttpFactory(
        new Provider<NodeProxyClient>(
            () =>
                new NodeProxyClient(
                    // webpieces-disable no-any-unknown -- test double: only buildOutboundHeaders/findRecorder are reached
                    new StubHeaders() as unknown as RequestContextHeaders,
                    // webpieces-disable no-any-unknown -- test double: only mintIdToken is reached
                    new StubOidc() as unknown as GcpOidc,
                    new FakeAddressResolver(),
                    // webpieces-disable no-any-unknown -- test double: only get() is reached
                    new StubSecrets() as unknown as Secrets,
                ),
        ),
    );
}

beforeEach(() => {
    ApiCallContextHolder.install(new NoopApiCallContext());
    sent = [];
    stubTransport();
    ClientRegistry.addUrlMapping('svc', 'https://svc.example');
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('createRpcClient filters are genuinely optional', () => {
    it('an empty array and an omitted argument produce the same call on the wire', async () => {
        const omitted = newFactory().createRpcClient(SvcApi, new ClientConfig('svc'));
        const empty = newFactory().createRpcClient(SvcApi, new ClientConfig('svc'), []);

        await RequestContext.run(() => omitted.work(new WorkRequest('a')));
        await RequestContext.run(() => empty.work(new WorkRequest('a')));

        expect(sent).toHaveLength(2);
        expect(sent[1].url).toBe(sent[0].url);
        expect(sent[1].headers).toEqual(sent[0].headers);
    });

    it('accepts a list built up conditionally — the shape a real app produces', async () => {
        // Dean's case verbatim: a MUTABLE array, declared empty, pushed to under `if`s. Its declared
        // type cannot be non-empty, which is exactly what the old tuple parameter rejected.
        const perTenant = false;
        const verbose = true;
        const filters: ClientFilterDefinition[] = [];
        if (perTenant) filters.push(new ClientFilterDefinition(1000, new OutboundLogFilter()));
        if (verbose) filters.push(new ClientFilterDefinition(500, new OutboundLogFilter()));

        const client = newFactory().createRpcClient(SvcApi, new ClientConfig('svc'), filters);
        await RequestContext.run(() => client.work(new WorkRequest('a')));

        expect(sent).toHaveLength(1);
        expect(sent[0].headers['x-log']).toBe('on');
    });

    it('a conditionally built list that stays EMPTY behaves like no filters at all', async () => {
        const perTenant = false;
        const verbose = false;
        const filters: ClientFilterDefinition[] = [];
        if (perTenant) filters.push(new ClientFilterDefinition(1000, new OutboundLogFilter()));
        if (verbose) filters.push(new ClientFilterDefinition(500, new OutboundLogFilter()));

        const built = newFactory().createRpcClient(SvcApi, new ClientConfig('svc'), filters);
        const omitted = newFactory().createRpcClient(SvcApi, new ClientConfig('svc'));

        await RequestContext.run(() => built.work(new WorkRequest('a')));
        await RequestContext.run(() => omitted.work(new WorkRequest('a')));

        expect(sent).toHaveLength(2);
        expect(sent[1].url).toBe(sent[0].url);
        expect(sent[1].headers).toEqual(sent[0].headers);
        expect(sent[0].headers['x-log']).toBeUndefined();
    });

    it('mutating the caller\'s array after the client is built does NOT change the client', async () => {
        // createRpcClient copies with [...filters], so the client is not a live view of the caller's
        // array. Worth pinning now that passing a mutable array is the normal case.
        const filters: ClientFilterDefinition[] = [];
        const client = newFactory().createRpcClient(SvcApi, new ClientConfig('svc'), filters);
        filters.push(new ClientFilterDefinition(500, new OutboundLogFilter()));

        await RequestContext.run(() => client.work(new WorkRequest('a')));

        expect(sent).toHaveLength(1);
        expect(sent[0].headers['x-log']).toBeUndefined();
    });
});
