import { inject } from 'inversify';
import { DocumentDesign } from '@webpieces/core-util';
import { Provider, bindFrameworkProvider, provideFrameworkSingleton } from '@webpieces/core-context';
import type { ApiPrototype } from '@webpieces/http-client-core';
import { buildClientProxy, ClientFilterDefinition } from '@webpieces/http-client-core';
import { ClientConfig } from './ClientConfig';
import { NODE_PROXY_CLIENT_PROVIDER, NodeProxyClient } from './NodeProxyClient';

// Teach the container how to hand out fresh NodeProxyClients. NodeProxyClient is bound TRANSIENT
// (@provideFrameworkTransient), so each provider.get() constructs a new one.
bindFrameworkProvider(NODE_PROXY_CLIENT_PROVIDER, NodeProxyClient);

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
 * const server2 = factory.createRpcClient(Server2Api, new ClientConfig('server2', new DeployedServiceHost()), []);
 *
 * // to reach somewhere derivation cannot describe (other region/project, non-Cloud-Run, localhost),
 * // register it once at startup — the client still carries only the svcName:
 * //   ClientRegistry.addUrlMapping('legacy', 'https://legacy.corp');
 * const legacy = factory.createRpcClient(LegacyApi, new ClientConfig('legacy', new DeployedServiceHost()), []);
 *
 * const response = await server2.fetchValue(req);   // inside a RequestContext
 * ```
 *
 * A destination that is DATA rather than deployment — a URL a partner registered — names a runtime
 * host policy instead, and typically installs a signing filter over the exact bytes:
 * ```typescript
 * const partner = factory.createRpcClient(
 *     PartnerWebhookApi,
 *     new ClientConfig('partner-webhooks', new RuntimeHostFromContext(new DnsAddressResolver())),
 *     [new ClientFilterDefinition(500, new HmacSigningFilter(secret))],
 * );
 * ```
 *
 * Every client it builds shares one {@link NodeProxyClient} *shape* but never one instance: the
 * injected `Provider<NodeProxyClient>` hands out a fresh one per contract, which `createRpcClient`
 * then `init`s. Their collaborators (RequestContextHeaders, Secrets) come from the container, so
 * the whole dependency graph is visible in this package's design.html.
 *
 * Unlike @webpieces/http-client-browser this package is Node-only, so the factory IS the inversify
 * entry point and the magic context is read straight from the RequestContext. A call made outside
 * `RequestContext.run(...)` throws rather than silently dropping the trace.
 */
@DocumentDesign()
@provideFrameworkSingleton()
export class ClientHttpFactory {
    constructor(
        @inject(NODE_PROXY_CLIENT_PROVIDER) private readonly proxyClientProvider: Provider<NodeProxyClient>,
    ) {}

    /**
     * Create a type-safe RPC (HTTP) client for one API contract.
     *
     * @param apiPrototype - The API prototype class with @ApiPath/@Endpoint decorators
     * @param config - This client's state (its svcName and its host policy)
     * @param filters - This client's OUTBOUND filters, each with the priority it runs at (highest
     *        OUTERMOST). They wrap the send, so a filter sees the final URL, may add headers, and
     *        may replace `ClientRequest.body` — the exact bytes transmitted, which is what makes
     *        signing possible without hand-serializing. Pass `[]` for a client that needs none;
     *        the argument is REQUIRED so "this client signs nothing" is written down rather than
     *        inferred from an omitted argument.
     */
    createRpcClient<T extends object>(
        apiPrototype: ApiPrototype<T>,
        config: ClientConfig,
        filters: ClientFilterDefinition[],
    ): T {
        // Fresh instance per contract — NodeProxyClient is transient. init() binds it to this
        // contract + target; the collaborators already came from the container.
        const proxyClient = this.proxyClientProvider.get();
        proxyClient.init(apiPrototype, config, filters);
        return buildClientProxy(apiPrototype, proxyClient);
    }
}
