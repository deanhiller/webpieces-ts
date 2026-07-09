import { inject, injectable } from 'inversify';
import { DocumentDesign } from '@webpieces/core-util';
import { bindFrameworkProvider, provideFrameworkSingleton } from '@webpieces/core-context';
import type { ApiPrototype } from '@webpieces/http-client-core';
import { buildClientProxy } from '@webpieces/http-client-core';
import { ClientConfig } from './ClientConfig';
import { NodeProxyClient, ProxyClientProvider } from './NodeProxyClient';

// Teach the container how to hand out fresh NodeProxyClients. NodeProxyClient is bound TRANSIENT
// (@provideFrameworkTransient), so each provider.get() constructs a new one.
bindFrameworkProvider(ProxyClientProvider, NodeProxyClient);

/**
 * ClientHttpFactory - builds type-safe HTTP clients from API prototypes carrying
 * @ApiPath/@Endpoint decorators. The SERVER-side factory.
 *
 * This is the client-side equivalent of ApiRoutingFactory:
 * - Server routing: ApiRoutingFactory reads decorators -> routes HTTP requests to controllers
 * - Server client:  ClientHttpFactory reads decorators -> generates HTTP requests from method calls
 *
 * Inject it and ask for a typed client per contract:
 * ```typescript
 * // same project + region as this container; the URL is derived, you maintain nothing
 * const server2 = factory.createClient(Server2Api, new ClientConfig('server2'));
 *
 * // or point somewhere lookup cannot describe (other region/project, non-Cloud-Run)
 * const legacy = factory.createClient(LegacyApi, new ClientConfig('legacy', 'https://legacy.corp'));
 *
 * const response = await server2.fetchValue(req);   // inside a RequestContext
 * ```
 *
 * Every client it builds shares one {@link NodeProxyClient} *shape* but never one instance: the
 * injected {@link ProxyClientProvider} hands out a fresh one per contract, which `createClient`
 * then `init`s. Their collaborators (RequestContextHeaders, Secrets) come from the container, so
 * the whole dependency graph is visible in this package's design.html.
 *
 * Unlike @webpieces/http-client-browser this package is Node-only, so the factory IS the inversify
 * entry point and the magic context is read straight from the RequestContext. A call made outside
 * `RequestContext.run(...)` throws rather than silently dropping the trace.
 */
@DocumentDesign()
@provideFrameworkSingleton()
@injectable()
export class ClientHttpFactory {
    constructor(
        @inject(ProxyClientProvider) private readonly proxyClientProvider: ProxyClientProvider,
    ) {}

    /**
     * Create a type-safe HTTP client for one API contract.
     *
     * @param apiPrototype - The API prototype class with @ApiPath/@Endpoint decorators
     * @param config - This client's state (its svcName, and optionally an explicit targetUrl)
     */
    createClient<T extends object>(apiPrototype: ApiPrototype<T>, config: ClientConfig): T {
        // Fresh instance per contract — NodeProxyClient is transient. init() binds it to this
        // contract + target; the collaborators already came from the container.
        const proxyClient = this.proxyClientProvider.get();
        proxyClient.init(apiPrototype, config);
        return buildClientProxy(apiPrototype, proxyClient);
    }
}
