import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    ApiPath,
    ClientRegistry,
    DestinationTrust,
    Endpoint,
    PathParam,
    QueryParam,
    Rpc,
    TestCaseRecorder,
    WpAuthPublic,
    GET,
    READ,
    RPC,
} from '@webpieces/core-util';
import { RequestContext } from '@webpieces/core-context';
import type { RequestContextHeaders } from '@webpieces/core-context';
import type { GcpOidc } from '@webpieces/gcp-identity';
import { buildClientProxy } from '@webpieces/http-client-core';
import { AddressResolver } from '../AddressResolver';
import { ClientConfig } from '../ClientConfig';
import { NodeProxyClient } from '../NodeProxyClient';

@Rpc()
@ApiPath('/inventory')
abstract class NodeTypedApi {
    @WpAuthPublic('Inventory metadata is public')
    @Endpoint(GET, '/{owner}/{item}', READ, RPC)
    // webpieces-disable no-unmanaged-exceptions -- contract stub
    get(
        @PathParam('owner') _owner: string,
        @PathParam('item') _item: number,
        @QueryParam('include_archived') _includeArchived?: boolean,
    ): Promise<object> {
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

class StubOidc {
    mintIdToken(_audience: string): Promise<string> {
        return Promise.resolve('never-used');
    }
}

class UnusedResolver extends AddressResolver {
    override resolve(_hostname: string): Promise<string[]> {
        return Promise.resolve([]);
    }
}

function client(): NodeTypedApi {
    const proxy = new NodeProxyClient(
        new StubHeaders() as unknown as RequestContextHeaders,
        new StubOidc() as unknown as GcpOidc,
        new UnusedResolver(),
    );
    proxy.init(NodeTypedApi, new ClientConfig('inventory'), []);
    return buildClientProxy(NodeTypedApi, proxy);
}

describe('node generated typed HTTP contracts', () => {
    beforeEach(() => {
        ClientRegistry.resetForTests();
        ClientRegistry.addUrlMapping('inventory', 'https://inventory.example.test');
    });

    afterEach(() => {
        ClientRegistry.resetForTests();
        vi.unstubAllGlobals();
    });

    it('uses the explicit GET/path/query contract and still requires ambient RequestContext', async () => {
        const fetchMock = vi.fn(
            (_url: string | URL | Request, _init?: RequestInit): Promise<Response> =>
                Promise.resolve(
                    new Response('{"ok":true}', {
                        status: 200,
                        headers: { 'content-type': 'application/json' },
                    }),
                ),
        );
        vi.stubGlobal('fetch', fetchMock);

        await expect(client().get('x', 3, true)).rejects.toThrow(/No active RequestContext/);
        const response = await RequestContext.run(() => client().get('Dean / Київ', 3, true));

        expect(response).toEqual({ ok: true });
        expect(fetchMock.mock.calls[0][0]).toBe(
            'https://inventory.example.test/inventory/Dean%20%2F%20%D0%9A%D0%B8%D1%97%D0%B2/3?include_archived=true',
        );
        expect(fetchMock.mock.calls[0][1]?.method).toBe('GET');
        expect(fetchMock.mock.calls[0][1]?.body).toBeUndefined();
    });
});
