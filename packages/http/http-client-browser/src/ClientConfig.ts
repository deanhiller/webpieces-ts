/**
 * Per-client STATE for a browser HTTP client — nothing else. A plain class; it extends nothing and
 * is unrelated to the server package's ClientConfig.
 *
 * A browser is simply handed the base URL of the API it calls (usually from an environment config),
 * because it has no container metadata to derive one from. That is the only difference from
 * http-client-node's ClientConfig, which names a Cloud Run service and resolves the URL from it.
 *
 * The context store is NOT config: it is a dependency of {@link ClientHttpBrowserFactory}, shared
 * by every client it builds.
 */
export class ClientConfig {
    constructor(
        /** Base URL for all requests (e.g., 'http://localhost:3000') */
        public readonly baseUrl: string,

        /** The callee's name for logging. Defaults to the baseUrl. */
        public readonly svcName: string = baseUrl,
    ) {}
}
