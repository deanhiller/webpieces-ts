import { ApiPrototype } from './ApiPrototype';
import { ProxyClient } from './ProxyClient';

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
 * Wrap an already-init'd {@link ProxyClient} in the typed Proxy that IS the client: every
 * `@Endpoint` method call becomes an HTTP request. Shared by the browser and Node factories so
 * the two environments cannot drift on framework-inspection behavior.
 */
// webpieces-disable no-function-outside-class -- returns a Proxy; it holds no state a class could own
export function buildClientProxy<T extends object>(apiPrototype: ApiPrototype<T>, proxyClient: ProxyClient): T {
    return new Proxy({} as T, {
        get(target: T, prop: string | symbol): ProxyGetResult | undefined {
            // Symbols (Symbol.toStringTag, Symbol.iterator, etc.) - throw for now to learn if this happens
            if (typeof prop !== 'string') {
                throw new Error(
                    `Proxy accessed with non-string property: ${String(prop)} (type: ${typeof prop}). ` +
                    `Please report this so we can add it to the whitelist.`
                );
            }

            // Framework inspection properties - return undefined to allow inspection WITHOUT
            // throwing. This is critical for Angular DI, Promise checks, etc.
            if (FRAMEWORK_INSPECTION_PROPERTIES.has(prop)) {
                return undefined;
            }

            if (!proxyClient.hasRoute(prop)) {
                // For unknown properties (likely typos), throw a helpful error
                throw new Error(
                    `No route found for method '${prop}' on ${apiPrototype.name || 'Unknown'}. ` +
                    `Check for typos or ensure the method has @Endpoint() decorator.`
                );
            }

            const route = proxyClient.getRoute(prop);

            // webpieces-disable no-any-unknown -- request DTO types are erased at the proxy boundary
            return async (...args: any[]) => {
                return proxyClient.makeRequest(route, args);
            };
        },
    });
}
