/**
 * Per-client STATE for a server-side HTTP client — nothing else. A plain class; it extends nothing
 * and is unrelated to the browser package's ClientConfig, because the two answer "what URL?"
 * differently and share nothing worth a base class.
 *
 * Collaborators (RequestContextHeaders, Secrets) are NOT config: they are dependencies of
 * {@link NodeProxyClient} and are shared by every client the factory builds. This is the RPC twin
 * of cloudtasks-client's TaskClientConfig, and takes the same two fields.
 */
export class ClientConfig {
    constructor(
        /**
         * TYPICALLY the GCP Cloud Run service name — and it MUST be the Cloud Run service name
         * when you do not supply a `targetUrl`, because we derive the URL from it.
         *
         * We lookup your service in the same project, same region, and form the url from the
         * container information unless you pass in a targetUrl, so you do not have to maintain
         * targetUrls. This works across your demo, qa, prod environments as long as each
         * environment is in its own projectId, which is typical.
         *
         * When you DO supply a `targetUrl`, svcName is used only for logging, so any readable
         * name works.
         */
        public readonly svcName: string,

        /**
         * Optional explicit base URL, for the cases lookup cannot describe: another region,
         * another project, or a host that is not Cloud Run at all. It wins over `svcName`.
         */
        public readonly targetUrl?: string,
    ) {}
}
