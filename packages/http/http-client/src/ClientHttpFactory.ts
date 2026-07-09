import { ContextMgr, Secrets } from '@webpieces/core-util';
import { ProxyClient } from './ProxyClient';
import { ApiPrototype, ClientConfig, IdTokenMinter } from './ClientConfig';

/**
 * Return type for the Proxy get trap — either an async method or undefined for framework inspection.
 */
// webpieces-disable no-any-unknown -- Proxy get trap returns generic response promises
type ProxyGetResult = (...args: never[]) => Promise<unknown>;

/**
 * Properties accessed by DI frameworks (Angular, Vue), debuggers, Promise checks, and serializers.
 * These should return undefined instead of throwing, allowing frameworks to inspect the proxy.
 *
 * Why this exists:
 * - Angular's injector profiler accesses `constructor` after useFactory returns
 * - Promise.resolve() checks for `then` to detect thenables
 * - JSON.stringify checks for `toJSON`
 * - Debuggers access `prototype`, `__proto__`, etc.
 */
const FRAMEWORK_INSPECTION_PROPERTIES = new Set([
    'constructor',     // Angular DI profiler, class inspection
    'prototype',       // Prototype chain inspection
    '__proto__',       // Legacy prototype access
    'name',            // Angular isNotFound() check, function/class name inspection
    'then',            // Promise/thenable detection
    'catch',           // Promise check
    'finally',         // Promise check
    'toJSON',          // JSON.stringify
    'valueOf',         // Type coercion
    'toString',        // String coercion
    'nodeType',        // DOM element check
    'tagName',         // DOM element check
    '$$typeof',        // React element/component check
    '$typeof',         // React internal
    '_isVue',          // Vue internal
    'ngOnInit',        // Angular lifecycle hook check
    'ngOnDestroy',     // Angular lifecycle hook check
    'ngOnChanges',     // Angular lifecycle hook check
    'asymmetricMatch', // Jest matcher protocol
]);

/**
 * ClientHttpFactory - builds type-safe HTTP clients from API prototypes carrying
 * @ApiPath/@Endpoint decorators.
 *
 * This is the client-side equivalent of ApiRoutingFactory.
 * - Server: ApiRoutingFactory reads decorators -> routes HTTP requests to controllers
 * - Client: ClientHttpFactory reads decorators -> generates HTTP requests from method calls
 *
 * The factory holds the COLLABORATORS shared by every client it builds (contextMgr,
 * idTokenMinter, secrets); each {@link ClientConfig} holds only that one client's STATE
 * (its baseUrl). Build the factory once per process and reuse it:
 *
 * ```typescript
 * // Node.js server-side:
 * const factory = new ClientHttpFactory(new ContextMgr(new RequestContextReader()), mintIdToken, secrets);
 * const saveClient = factory.createClient(SaveApi, new ClientConfig('http://localhost:3000'));
 * const response = await saveClient.save({ query: 'test' }); // Type-safe!
 *
 * // Browser (no minter, no secrets — a browser cannot hold service credentials):
 * const factory = new ClientHttpFactory(new ContextMgr(new MutableContextStore()));
 * const saveClient = factory.createClient(SaveApi, new ClientConfig(apiBaseUrl));
 * ```
 *
 * Deliberately a plain class with NO inversify decorators: Angular bundles this package
 * into the browser, so it must not pull in a Node DI container. A Node app binds it with
 * `toDynamicValue`; Angular with `useFactory`.
 */
export class ClientHttpFactory {
    constructor(
        private readonly contextMgr?: ContextMgr,
        private readonly idTokenMinter?: IdTokenMinter,
        private readonly secrets?: Secrets,
    ) {}

    /**
     * Create a type-safe HTTP client for one API contract.
     *
     * @param apiPrototype - The API prototype class with @ApiPath/@Endpoint decorators
     * @param config - This client's state (its baseUrl)
     * @returns A proxy object that implements the API interface
     */
    createClient<T extends object>(apiPrototype: ApiPrototype<T>, config: ClientConfig): T {
        // ProxyClient owns @ApiPath validation + route building from the API's decorators
        // (see its constructor). It is the @DocumentDesign design root for this package.
        const proxyClient = new ProxyClient(
            apiPrototype,
            config,
            this.contextMgr,
            this.idTokenMinter,
            this.secrets,
        );

        // Create a proxy that intercepts method calls and makes HTTP requests
        return new Proxy({} as T, {
            get(target: T, prop: string | symbol): ProxyGetResult | undefined {
                // Symbols (Symbol.toStringTag, Symbol.iterator, etc.) - throw for now to learn if this happens
                if (typeof prop !== 'string') {
                    throw new Error(
                        `Proxy accessed with non-string property: ${String(prop)} (type: ${typeof prop}). ` +
                        `Please report this so we can add it to the whitelist.`
                    );
                }

                // Framework inspection properties - return undefined to allow inspection
                // WITHOUT throwing. This is critical for Angular DI, Promise checks, etc.
                if (FRAMEWORK_INSPECTION_PROPERTIES.has(prop)) {
                    return undefined;
                }

                // Check if this property is actually a route method
                if (!proxyClient.hasRoute(prop)) {
                    // For unknown properties (likely typos), throw a helpful error
                    throw new Error(
                        `No route found for method '${prop}'. ` +
                        `Check for typos or ensure the method has @Endpoint() decorator.`
                    );
                }

                const route = proxyClient.getRoute(prop);

                // Return a function that makes the HTTP request
                // webpieces-disable no-any-unknown -- request DTO types are erased at the proxy boundary
                return async (...args: any[]) => {
                    return proxyClient.makeRequest(route, args);
                };
            },
        });
    }
}
