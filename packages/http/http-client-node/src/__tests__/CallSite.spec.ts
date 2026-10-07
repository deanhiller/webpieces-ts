import 'reflect-metadata';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    ApiCallSite,
    ApiDependencyError,
    ApiPath,
    AuthorizationType,
    ClientRegistry,
    ClientRole,
    DestinationTrust,
    Endpoint,
    POST,
    READ,
    ReportableApiFailure,
    Rpc,
    RPC,
    TestCaseRecorder,
    WpAuthorization,
    WpAuthPublic,
} from '@webpieces/core-util';
import type { RequestContextHeaders } from '@webpieces/core-context';
import { RequestContext } from '@webpieces/core-context';
import type { GcpOidc } from '@webpieces/gcp-identity';
import { buildClientProxy } from '@webpieces/http-client-core';
import { AddressResolver } from '../AddressResolver';
import { ClientConfig } from '../ClientConfig';
import { NodeProxyClient } from '../NodeProxyClient';

class FetchStoresRequest {
    constructor(public readonly limit: number) {}
}

@Rpc()
@ApiPath('/db-stores')
abstract class DbStoresApi {
    @Endpoint(POST, '/fetch-stores', READ, RPC)
    @WpAuthPublic('Anonymous access is intentionally required')
    @WpAuthorization({
        authType: AuthorizationType.ANONYMOUS,
        reason: 'Anonymous access is intentionally required',
    })
    // webpieces-disable no-unmanaged-exceptions -- abstract contract stub, never executed
    fetchStores(_request: FetchStoresRequest): Promise<void> {
        throw new Error('contract only');
    }
}

/** RequestContextHeaders stand-in: no context keys, no recorder. */
class StubHeaders {
    buildOutboundHeaders(_destination: DestinationTrust): Map<string, string> {
        return new Map<string, string>();
    }
    acceptResponseHeaders(_headers: Headers, _destination: DestinationTrust): void {}
    findRecorder(): TestCaseRecorder | undefined {
        return undefined;
    }
}

/** Every url here comes from ClientRegistry, so the SSRF guard never resolves anything. */
class ThrowingAddressResolver extends AddressResolver {
    override resolve(hostname: string): Promise<string[]> {
        throw new Error(`the SSRF guard must not resolve ${hostname}`);
    }
}

class StubOidc {
    mintIdToken(_audience: string): Promise<string> {
        return Promise.resolve('never-used');
    }
}

// webpieces-disable no-function-outside-class -- builds the client exactly as ClientHttpFactory does
function client(): DbStoresApi {
    const proxyClient = new NodeProxyClient(
        // webpieces-disable no-any-unknown -- test double: only buildOutboundHeaders/findRecorder are reached
        new StubHeaders() as unknown as RequestContextHeaders,
        // webpieces-disable no-any-unknown -- test double: no @WpAuthOidc endpoint exists in this spec
        new StubOidc() as unknown as GcpOidc,
        new ThrowingAddressResolver(),
    );
    proxyClient.init(DbStoresApi, new ClientConfig('pg-dataaccess', ClientRole.SERVER), []);
    return buildClientProxy(DbStoresApi, proxyClient);
}

// webpieces-disable no-function-outside-class -- the NAMED server-code frame the captured stack must show
async function loadStoresForReport(api: DbStoresApi): Promise<unknown> {
    // webpieces-disable no-unmanaged-exceptions -- the rejection IS what this spec inspects
    return api.fetchStores(new FetchStoresRequest(5)).catch((err: unknown) => err);
}

beforeEach(() => {
    ClientRegistry.resetForTests();
    ClientRegistry.addUrlMapping('pg-dataaccess', 'https://pg-dataaccess.example.com');
    vi.stubGlobal(
        'fetch',
        vi.fn(() =>
            Promise.resolve(
                new Response(JSON.stringify({ kind: 'implementation', message: 'boom' }), {
                    status: 500,
                    headers: { 'Content-Type': 'application/json' },
                }),
            ),
        ),
    );
});

afterEach(() => {
    ClientRegistry.resetForTests();
    vi.unstubAllGlobals();
});

describe('node api clients capture the caller stack on a failed call (#1175)', () => {
    it('server-to-server: the rejected error names the calling function, not only ProxyClient frames', async () => {
        const api = client();
        const failure = await RequestContext.run(() => loadStoresForReport(api));

        expect(failure).toBeInstanceOf(ApiDependencyError);
        const callSite = (failure as ApiDependencyError).callSite;
        expect(callSite).toBeInstanceOf(ApiCallSite);
        expect(callSite!.label).toBe('DbStoresApi.fetchStores');
        const frames = (callSite!.stack ?? '').split('\n').slice(1);
        expect(frames[0]).toContain('loadStoresForReport');
        expect(frames.join('\n')).not.toContain('ProxyClient');
        expect(ReportableApiFailure.toReportableError(failure)!.fingerprint).toEqual([
            'ApiDependencyError',
            'DbStoresApi.fetchStores',
        ]);
    });
});
