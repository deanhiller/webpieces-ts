/**
 * ClientRegistry - the process-global `svcName -> base URL` table of per-environment URL overrides
 * used to route outbound client calls.
 *
 * On GCP a client resolves a peer's base URL deterministically from `K_SERVICE` + project + region
 * (see gcp-identity `resolveServiceUrl`), so same-project/same-region services need NO registration.
 * Everything the derivation cannot describe — a localhost port, another region, another project, a
 * host that is not Cloud Run at all, or a browser that cannot read `K_SERVICE` — is registered here
 * instead. Each environment populates the registry (from its own per-env config) with the URLs it
 * needs; a registered mapping WINS over GCP derivation.
 *
 * - **http-client-node / cloudtasks-client** resolve through gcp-identity `resolveServiceUrl`: it
 *   checks {@link ClientRegistry.tryLookup} first (override), then derives on GCP, then throws
 *   off-GCP if unregistered — a missing mapping is a setup bug, not a silent mis-route.
 * - **http-client-browser** cannot derive GCP URLs, so it resolves purely via
 *   {@link ClientRegistry.lookup}; the Angular app registers each svcName at startup.
 *
 * Configured like {@link HeaderRegistry} / LogManager — populated once at startup, then globally
 * accessible with NO DI wiring. It is browser-safe (no `process.env`, no node-only deps), which is
 * why it lives in core-util rather than gcp-identity.
 *
 * ```ts
 * // startup, populated from the current environment's config:
 * ClientRegistry.addMapping('server2', 8202);                       // -> http://localhost:8202
 * ClientRegistry.addUrlMapping('email', 'https://email.other-region.example');
 * ```
 */
export class ClientRegistry {
    /** svcName -> resolved base URL. Process-global; populated at startup per environment. */
    private static readonly mappings = new Map<string, string>();

    /** Map a service name to `http://localhost:<port>`. */
    // webpieces-disable no-function-outside-class -- static global singleton (like HeaderRegistry/LogManager); populated once at startup, never DI-injected
    static addMapping(svcName: string, port: number): void {
        ClientRegistry.mappings.set(svcName, `http://localhost:${port}`);
    }

    /** Map a service name to an explicit base URL (any host / any environment). */
    // webpieces-disable no-function-outside-class -- static global singleton (like HeaderRegistry/LogManager); populated once at startup, never DI-injected
    static addUrlMapping(svcName: string, url: string): void {
        ClientRegistry.mappings.set(svcName, url);
    }

    /** The registered override for `svcName`, or undefined if none. Non-throwing. */
    // webpieces-disable no-function-outside-class -- static global singleton (like HeaderRegistry/LogManager); populated once at startup, never DI-injected
    static tryLookup(svcName: string): string | undefined {
        return ClientRegistry.mappings.get(svcName);
    }

    /**
     * Resolve `svcName` to its registered base URL. THROWS with actionable guidance if the service
     * was never registered — used where there is no GCP-derivation fallback (the browser).
     */
    // webpieces-disable no-function-outside-class -- static global singleton (like HeaderRegistry/LogManager); populated once at startup, never DI-injected
    static lookup(svcName: string): string {
        const url = ClientRegistry.tryLookup(svcName);
        if (url === undefined) {
            throw new Error(
                `No URL registered for service "${svcName}". Register it at startup: ` +
                `ClientRegistry.addMapping(svcName, port) for a localhost port, or ` +
                `ClientRegistry.addUrlMapping(svcName, url) for an explicit URL.`,
            );
        }
        return url;
    }

    /** Reset the registry. For tests, so the process-global map does not leak across specs. */
    // webpieces-disable no-function-outside-class -- static global singleton (like HeaderRegistry/LogManager); populated once at startup, never DI-injected
    static clear(): void {
        ClientRegistry.mappings.clear();
    }
}
