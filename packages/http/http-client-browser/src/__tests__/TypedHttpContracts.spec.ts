import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    ApiPath,
    ClientRegistry,
    Endpoint,
    HttpResponseDto,
    HeaderRegistry,
    PathParam,
    QueryParam,
    Rpc,
    WpAuthPublic,
} from '@webpieces/core-util';
import { ClientConfig } from '../ClientConfig';
import { ClientHttpBrowserFactory } from '../ClientHttpBrowserFactory';
import { MutableContextStore } from '../MutableContextStore';

class TokenRequest {
    constructor(
        public readonly code: string,
        public readonly code_verifier: string,
        public readonly scope?: string[],
    ) {}
}

@Rpc()
@ApiPath('/oauth')
abstract class BrowserTypedApi {
    @WpAuthPublic('OAuth metadata is public by protocol')
    @Endpoint('/resource/{resourceId}', 'rpc', { httpMethod: 'GET' })
    // webpieces-disable no-unmanaged-exceptions -- contract stub
    resource(
        @PathParam('resourceId') _resourceId: string,
        @QueryParam('scope') _scopes?: string[],
    ): Promise<object> {
        throw new Error('contract only');
    }

    @WpAuthPublic('OAuth token exchanges authenticate their grant payload')
    @Endpoint('/token', 'rpc', { formPost: true, responseType: 'full' })
    // webpieces-disable no-unmanaged-exceptions -- contract stub
    token(_request: TokenRequest): Promise<HttpResponseDto<object>> {
        throw new Error('contract only');
    }

    @WpAuthPublic('OAuth authorization redirects are protocol responses')
    @Endpoint('/authorize', 'rpc', { httpMethod: 'GET', responseType: 'full' })
    // webpieces-disable no-unmanaged-exceptions -- contract stub
    authorize(@QueryParam('client_id') _clientId: string): Promise<HttpResponseDto<undefined>> {
        throw new Error('contract only');
    }
}

describe('browser generated typed HTTP contracts', () => {
    let client: BrowserTypedApi;

    beforeEach(() => {
        HeaderRegistry.configure([], true);
        ClientRegistry.resetForTests();
        ClientRegistry.addUrlMapping('oauth', 'https://api.example.test');
        client = new ClientHttpBrowserFactory(new MutableContextStore()).createRpcClient(
            BrowserTypedApi,
            new ClientConfig('oauth'),
        );
    });

    afterEach(() => {
        ClientRegistry.resetForTests();
        vi.unstubAllGlobals();
    });

    it('sends GET without a body and builds encoded path/repeated query values', async () => {
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

        await client.resource('a/b ✓', ['read all', 'write&more']);

        expect(fetchMock.mock.calls[0][0]).toBe(
            'https://api.example.test/oauth/resource/a%2Fb%20%E2%9C%93?scope=read%20all&scope=write%26more',
        );
        expect(fetchMock.mock.calls[0][1]?.method).toBe('GET');
        expect(fetchMock.mock.calls[0][1]?.body).toBeUndefined();
    });

    it('sends formPost bodies symmetrically and returns the full typed response', async () => {
        const fetchMock = vi.fn(
            (_url: string | URL | Request, _init?: RequestInit): Promise<Response> =>
                Promise.resolve(
                    new Response('{"access_token":"abc"}', {
                        status: 200,
                        headers: { 'content-type': 'application/json', 'x-token': 'issued' },
                    }),
                ),
        );
        vi.stubGlobal('fetch', fetchMock);

        const response = await client.token(
            new TokenRequest('a+b', 'space value', ['read all', 'write']),
        );

        expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({
            'Content-Type': 'application/x-www-form-urlencoded',
        });
        expect(fetchMock.mock.calls[0][1]?.body).toBe(
            'code=a%2Bb&code_verifier=space+value&scope=read+all&scope=write',
        );
        expect(response).toBeInstanceOf(HttpResponseDto);
        expect(response.body).toEqual({ access_token: 'abc' });
    });

    it('does not auto-follow when the contract owns redirect status and headers', async () => {
        const fetchMock = vi.fn(
            (_url: string | URL | Request, _init?: RequestInit): Promise<Response> =>
                Promise.resolve(
                    new Response(null, { status: 302, headers: { location: '/consent' } }),
                ),
        );
        vi.stubGlobal('fetch', fetchMock);

        const response = await client.authorize('client-1');

        expect(fetchMock.mock.calls[0][1]?.redirect).toBe('manual');
        expect(response.status.code).toBe(302);
        expect(response.headers).toContainEqual(
            expect.objectContaining({ name: 'location', value: '/consent' }),
        );
        expect(response.body).toBeUndefined();
    });
});
