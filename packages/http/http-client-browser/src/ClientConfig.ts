/**
 * Per-client STATE for a browser HTTP client — nothing else. A plain class; it extends nothing and
 * is unrelated to the server package's ClientConfig.
 *
 * A browser cannot read `K_SERVICE`, so it cannot derive a Cloud Run URL. It resolves its base URL
 * entirely through the global {@link ClientRegistry} by `svcName` — the Angular app registers each
 * svcName at startup (from its per-environment config; on localhost that URL points at a local port,
 * in the cloud at the deployed host). So this config is just the svcName.
 *
 * The context store is NOT config: it is a dependency of {@link ClientHttpBrowserFactory}, shared
 * by every client it builds.
 */
export class ClientConfig {
    constructor(
        /** Service name; resolved to a base URL via ClientRegistry (registered at app startup). */
        public readonly svcName: string,
    ) {}
}
