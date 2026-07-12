/**
 * Per-client STATE for a server-side HTTP client — nothing else. A plain class; it extends nothing
 * and is unrelated to the browser package's ClientConfig, because the two answer "what URL?"
 * differently and share nothing worth a base class.
 *
 * Collaborators (RequestContextHeaders, Secrets) are NOT config: they are dependencies of
 * {@link NodeProxyClient} and are shared by every client the factory builds. This is the RPC twin
 * of cloudtasks-client's TaskClientConfig, and takes the same single field.
 */
export class ClientConfig {
    constructor(
        /**
         * The service name. On GCP the URL is DERIVED from it (same project, same region — the Cloud
         * Run service name, so you maintain no URL table), which works across demo/qa/prod. Anything
         * the derivation cannot describe — a localhost port, another region/project, a non-Cloud-Run
         * host — is a `ClientRegistry` mapping registered at startup, NOT a per-client URL.
         */
        public readonly svcName: string,
    ) {}
}
