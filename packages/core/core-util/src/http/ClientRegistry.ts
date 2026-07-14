/**
 * Derives a base URL for a service name that has NO registered mapping — the pluggable half of
 * {@link ClientRegistry} resolution. One per environment, installed once at startup:
 *
 * - `gcpCloudRunDeriver()` (@webpieces/gcp-identity) — the Cloud Run formula, read from the metadata
 *   server. For code running ON GCP.
 * - `gcpCloudRunDeriver(new GcpCloudRunTarget(projectNumber, region))` — the SAME formula with the
 *   values supplied from config, for code running OFF GCP that still calls Cloud Run (a CLI, CI).
 * - {@link templateDeriver} (this package, browser-safe) — pure string substitution, for AWS or
 *   anything else with predictable DNS.
 * - none at all — a browser goes same-origin, and localhost/tests hand-register their mappings.
 */
export type ServiceUrlDeriver = (svcName: string) => Promise<string>;

/**
 * ClientRegistry - the ONE place a `svcName` becomes a base URL, for every outbound client in every
 * environment. A client is built once but a URL is per-environment, so the URL belongs here rather
 * than on the client: clients carry ONLY a svcName.
 *
 * Resolution is one precedence chain, identical in the browser, in node, and in Cloud Tasks:
 *
 *   1. a registered mapping wins — the localhost port table, AWS, an external API, another region
 *      or project, a host that is not Cloud Run at all. Populated at startup from per-env config.
 *   2. else the installed {@link ServiceUrlDeriver}, if any — GCP's built-in, a DNS template, or
 *      your own. OPTIONAL on purpose: localhost is inherently a TABLE (helper-fsdb -> :8401,
 *      helper-portal -> :8201 have per-service ports), so explicit mappings must stay sufficient on
 *      their own.
 *   3. else the caller's fallback: the BROWSER goes relative (same origin — see
 *      {@link ClientRegistry.tryResolve}), while node THROWS (see {@link ClientRegistry.resolve}),
 *      because a server has no "own origin" and an unresolvable peer is a setup bug.
 *
 * Configured like {@link HeaderRegistry} / LogManager — populated once at startup, then globally
 * accessible with NO DI wiring. It is browser-safe (no `process.env`, no node-only deps), which is
 * why it lives in core-util rather than gcp-identity.
 *
 * ```ts
 * // startup, from the current environment's config:
 * ClientRegistry.addMapping('server2', 8202);                       // -> http://localhost:8202
 * ClientRegistry.addUrlMapping('email', 'https://email.other-region.example');
 * ClientRegistry.setDeriver(gcpCloudRunDeriver());                  // everything else, on GCP
 * ```
 */
export class ClientRegistry {
    /** svcName -> resolved base URL. Process-global; populated at startup per environment. */
    private static readonly mappings = new Map<string, string>();

    /** The fallback for svcNames with no mapping. Undefined = no derivation in this environment. */
    private static deriver: ServiceUrlDeriver | undefined;

    /** Map a service name to `http://localhost:<port>`. */
    // webpieces-disable no-function-outside-class -- static global singleton (like HeaderRegistry/LogManager); populated once at startup, never DI-injected
    static addMapping(svcName: string, port: number): void {
        ClientRegistry.mappings.set(svcName, `http://localhost:${port}`);
    }

    /**
     * Map a service name to an explicit base URL (any host / any environment).
     *
     * The EMPTY STRING is a legal, meaningful mapping: it makes the service relative, i.e.
     * same-origin, because the client builds its URL as `${baseUrl}${route.path}`.
     */
    // webpieces-disable no-function-outside-class -- static global singleton (like HeaderRegistry/LogManager); populated once at startup, never DI-injected
    static addUrlMapping(svcName: string, url: string): void {
        ClientRegistry.mappings.set(svcName, url);
    }

    /**
     * Install the environment's {@link ServiceUrlDeriver} — how to resolve a svcName that has NO
     * mapping. Optional: an environment that registers every svcName it calls needs none.
     */
    // webpieces-disable no-function-outside-class -- static global singleton (like HeaderRegistry/LogManager); populated once at startup, never DI-injected
    static setDeriver(fn: ServiceUrlDeriver): void {
        ClientRegistry.deriver = fn;
    }

    /** The registered override for `svcName`, or undefined if none. Registry only — no derivation. */
    // webpieces-disable no-function-outside-class -- static global singleton (like HeaderRegistry/LogManager); populated once at startup, never DI-injected
    static tryLookup(svcName: string): string | undefined {
        return ClientRegistry.mappings.get(svcName);
    }

    /**
     * Resolve `svcName` to its registered base URL. THROWS if the service was never registered.
     * Registry only — it does NOT consult the deriver; prefer {@link ClientRegistry.resolve}.
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

    /**
     * Steps 1 + 2 of the chain: the registered mapping, else the installed deriver, else undefined.
     * Non-throwing — the BROWSER uses this and treats undefined as "" (relative → same origin),
     * which is what a browser app calling the backend it was served from wants by default.
     *
     * Note the `!== undefined` guard: an empty-string mapping is a legal answer ("this service is
     * same-origin"), so it must NOT fall through to derivation.
     */
    // webpieces-disable no-function-outside-class -- static global singleton (like HeaderRegistry/LogManager); populated once at startup, never DI-injected
    static tryResolve(svcName: string): Promise<string | undefined> {
        const override = ClientRegistry.tryLookup(svcName);
        if (override !== undefined) {
            return Promise.resolve(override);
        }
        if (!ClientRegistry.deriver) {
            return Promise.resolve(undefined);
        }
        return ClientRegistry.deriver(svcName);
    }

    /**
     * The full chain, with node's fallback: mapping, else deriver, else THROW. A server has no "own
     * origin" to go relative to, so an unresolvable peer is a setup bug and must fail loudly — and
     * say how to fix it.
     */
    // webpieces-disable no-function-outside-class -- static global singleton (like HeaderRegistry/LogManager); populated once at startup, never DI-injected
    static async resolve(svcName: string): Promise<string> {
        const url = await ClientRegistry.tryResolve(svcName);
        if (url === undefined) {
            throw new Error(
                `No URL for service "${svcName}".\n` +
                `  - localhost/AWS: ClientRegistry.addMapping('${svcName}', 8401)\n` +
                `                or ClientRegistry.addUrlMapping('${svcName}', 'https://...')\n` +
                `  - GCP: install a deriver — ClientRegistry.setDeriver(gcpCloudRunDeriver())\n` +
                `  - typo? svcName must be the CLOUD RUN service name, not your project/module name`,
            );
        }
        return url;
    }

    /** Reset mappings AND the deriver. For tests, so the process-globals do not leak across specs. */
    // webpieces-disable no-function-outside-class -- static global singleton (like HeaderRegistry/LogManager); populated once at startup, never DI-injected
    static clear(): void {
        ClientRegistry.mappings.clear();
        ClientRegistry.deriver = undefined;
    }
}
