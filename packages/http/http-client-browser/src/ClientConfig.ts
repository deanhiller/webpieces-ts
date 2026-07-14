/**
 * Per-client STATE for a browser HTTP client — nothing else. A plain class; it extends nothing and
 * is unrelated to the server package's ClientConfig.
 *
 * The base URL is resolved from `svcName` through the global {@link ClientRegistry}: a registered
 * mapping, else the installed deriver, else RELATIVE — i.e. the origin that served the page, which
 * is what a browser app calling its own backend wants and needs NO configuration. Register a mapping
 * only when the backend is somewhere else (an Angular dev server on :4201 reaching :8201). So this
 * config is just the svcName, and an unregistered one never throws.
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
