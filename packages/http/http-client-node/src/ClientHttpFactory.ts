import { inject } from 'inversify';
import { DocumentDesign } from '@webpieces/core-util';
import { Provider, bindFrameworkProvider, provideFrameworkSingleton } from '@webpieces/core-context';
import type { ApiPrototype } from '@webpieces/http-client-core';
import { buildClientProxy } from '@webpieces/http-client-core';
import type { ClientFilters } from '@webpieces/http-client-core';
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
 * const server2 = factory.createRpcClient(Server2Api, new ClientConfig('server2'));
 *
 * // to reach somewhere derivation cannot describe (other region/project, non-Cloud-Run, localhost),
 * // register it once at startup — the client still carries only the svcName:
 * //   ClientRegistry.addUrlMapping('legacy', 'https://legacy.corp');
 * const legacy = factory.createRpcClient(LegacyApi, new ClientConfig('legacy'));
 *
 * const response = await server2.fetchValue(req);   // inside a RequestContext
 * ```
 *
 * A destination that is DATA rather than deployment — a URL a partner registered — is a FILTER, not
 * a different kind of client. Install `ContextBaseUrlFilter` on the one client that may be
 * re-pointed, and set the URL per call:
 * ```typescript
 * const partner = factory.createRpcClient(PartnerWebhookApi, new ClientConfig('partner-webhooks'), [
 *     new ClientFilterDefinition(1000, new ContextBaseUrlFilter()),
 * ]);
 * ```
 * The SSRF guard arms itself the moment that filter re-points a request, and the contract's
 * `@AuthWebhook(name)` selects the app's bound `WebhookSignerCallback` to sign the exact bytes —
 * neither is something the app registers, orders, or can displace.
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
     * @param config - This client's state: its svcName, which is what `ClientRegistry` resolves
     * @param filters - This client's own OUTBOUND filters, each with the priority it runs at
     *        (highest OUTERMOST). They wrap the send, so a filter may rewrite the URL, add or remove
     *        headers, log, or replace `ClientRequest.body` — the exact bytes transmitted. What goes
     *        here is APP behaviour: url rewriting, headers, logging, and `ContextBaseUrlFilter` when
     *        this client's destination arrives per call.
     *
     *        OPTIONAL, and omitting it is not a statement about security: the framework's own SSRF
     *        guard and credential minter are installed on every client regardless, BENEATH anything
     *        passed here, so there is nothing an app can decline by writing nothing.
     *
     *        ONE SPELLING PER DECISION. It is a NON-EMPTY tuple, so `createRpcClient(Api, cfg, [])`
     *        does not compile: "this client has no app filters" is said by omitting the argument, and
     *        `[]` would be a second way to say the identical thing. That is the same device
     *        {@link JwtRoles}'s `roles` uses, for the same reason — the bad case is deleted by the
     *        TYPE rather than left available and discouraged in a docstring. Pinned in
     *        {@link CreateRpcClientCompileAssertions}.
     */
    createRpcClient<T extends object>(
        apiPrototype: ApiPrototype<T>,
        config: ClientConfig,
        filters?: ClientFilters,
    ): T {
        // Fresh instance per contract — NodeProxyClient is transient. init() binds it to this
        // contract + target; the collaborators already came from the container.
        const proxyClient = this.proxyClientProvider.get();
        proxyClient.init(apiPrototype, config, filters === undefined ? [] : [...filters]);
        return buildClientProxy(apiPrototype, proxyClient);
    }
}
