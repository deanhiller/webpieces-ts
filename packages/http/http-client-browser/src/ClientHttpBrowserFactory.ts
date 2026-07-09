import { ContextMgr, DocumentDesign } from '@webpieces/core-util';
import { ApiPrototype, buildClientProxy } from '@webpieces/http-client-core';
import { BrowserProxyClient } from './BrowserProxyClient';
import { ClientConfig } from './ClientConfig';
import { MutableContextStore } from './MutableContextStore';

/**
 * ClientHttpBrowserFactory - builds type-safe HTTP clients for a BROWSER from API prototypes
 * carrying @ApiPath/@Endpoint decorators.
 *
 * Deliberately a plain class with NO decorators and NO inversify: this package may be bundled by
 * React just as easily as by Angular, and neither should be forced to adopt a Node DI container.
 * The app provides it through whatever DI it already has — Angular's `useFactory`, a React context,
 * or a module-level `const`.
 *
 * The factory holds the ONE collaborator every browser client shares (the app's
 * {@link MutableContextStore}); each {@link ClientConfig} holds only that one client's base URL.
 *
 * ```typescript
 * // once, at startup (after HeaderRegistry.configure(...)):
 * const store = new MutableContextStore();
 * const factory = new ClientHttpBrowserFactory(store);
 *
 * const saveApi = factory.createClient(SaveApi, new ClientConfig(env.apiBaseUrl));
 * const response = await saveApi.save({ query: 'test' }); // type-safe
 *
 * // later, when the user logs in / picks a tenant — every subsequent call carries them:
 * store.set(AppHeaders.AUTHORIZATION, token);   // an app-defined key, if it wants auto-attach
 * store.set(CompanyHeaders.TENANT_ID, tenantId);
 * ```
 *
 * A browser cannot hold service credentials, so a contract with an @AuthOidc or @AuthSharedSecret
 * endpoint throws in `createClient`, not on the first call.
 */
@DocumentDesign()
export class ClientHttpBrowserFactory {
    private readonly contextMgr: ContextMgr;

    constructor(store: MutableContextStore) {
        this.contextMgr = new ContextMgr(store);
    }

    /**
     * Create a type-safe HTTP client for one API contract.
     *
     * @param apiPrototype - The API prototype class with @ApiPath/@Endpoint decorators
     * @param config - This client's state (its baseUrl)
     */
    createClient<T extends object>(apiPrototype: ApiPrototype<T>, config: ClientConfig): T {
        const proxyClient = new BrowserProxyClient(this.contextMgr);
        proxyClient.init(apiPrototype, config);
        return buildClientProxy(apiPrototype, proxyClient);
    }
}
