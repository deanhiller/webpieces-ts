import 'reflect-metadata';
import { describe, it, expect, beforeEach } from 'vitest';
import {
    ApiPath,
    AuthOidc,
    AuthSharedSecret,
    ContextKey,
    Endpoint,
    HeaderRegistry,
    Public,
    Rpc,
} from '@webpieces/core-util';
import { ClientConfig } from '../ClientConfig';
import { ClientHttpBrowserFactory } from '../ClientHttpBrowserFactory';
import { MutableContextStore } from '../MutableContextStore';

class SaveRequest {
    constructor(public readonly query: string) {}
}

@Rpc()
@ApiPath('/public')
abstract class PublicApi {
    @Endpoint('/save')
    @Public()
    // webpieces-disable no-unmanaged-exceptions -- abstract contract stub, never executed
    save(_request: SaveRequest): Promise<void> {
        throw new Error('contract only');
    }
}

@Rpc()
@ApiPath('/secure')
abstract class OidcApi {
    @Endpoint('/internalOp')
    @AuthOidc()
    // webpieces-disable no-unmanaged-exceptions -- abstract contract stub, never executed
    internalOp(_request: SaveRequest): Promise<void> {
        throw new Error('contract only');
    }
}

@Rpc()
@ApiPath('/secret')
abstract class SharedSecretApi {
    @Endpoint('/internalOp')
    @AuthSharedSecret('INTERNAL_API_SECRET')
    // webpieces-disable no-unmanaged-exceptions -- abstract contract stub, never executed
    internalOp(_request: SaveRequest): Promise<void> {
        throw new Error('contract only');
    }
}

const TENANT = new ContextKey('tenantId', 'x-tenant-id');

let factory: ClientHttpBrowserFactory;

beforeEach(() => {
    HeaderRegistry.configure([TENANT], /*platformHeaders*/ true);
    factory = new ClientHttpBrowserFactory(new MutableContextStore());
});

/**
 * A browser holds no service credentials: it cannot mint an OIDC token as a runtime service
 * account, and it must never ship a shared secret. Both are rejected at createRpcClient(), not on the
 * first call in production.
 */
describe('BrowserProxyClient rejects endpoints a browser cannot satisfy', () => {
    it('throws for an @AuthOidc contract', () => {
        expect(() => factory.createRpcClient(OidcApi, new ClientConfig('save-svc')))
            .toThrow(/@AuthOidc — a browser cannot hold service credentials/);
    });

    it('throws for an @AuthSharedSecret contract', () => {
        expect(() => factory.createRpcClient(SharedSecretApi, new ClientConfig('save-svc')))
            .toThrow(/@AuthSharedSecret — a browser cannot hold service credentials/);
    });

    it('accepts a @Public contract and binds its routes', () => {
        const client = factory.createRpcClient(PublicApi, new ClientConfig('save-svc'));

        // The Proxy resolves the declared endpoint...
        expect(typeof client.save).toBe('function');
        // ...and rejects one the contract never declared.
        // webpieces-disable no-any-unknown -- deliberately probing an undeclared method
        expect(() => (client as any).notAnEndpoint).toThrow(/No route found for method 'notAnEndpoint'/);
    });
});
