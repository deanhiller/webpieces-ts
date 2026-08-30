/**
 * Per-client STATE for a server-side HTTP client — nothing else. A plain class; it extends nothing
 * and is unrelated to the browser package's ClientConfig, because the two answer "what URL?"
 * differently and share nothing worth a base class.
 *
 * Collaborators (RequestContextHeaders, Secrets) are NOT config: they are dependencies of
 * {@link NodeProxyClient} and are shared by every client the factory builds. Outbound FILTERS are
 * not config either — they are per-client collaborators an app constructs, so they are the optional
 * third argument to `createRpcClient` rather than a field here.
 *
 * ## Why WHERE a client points is not stated here
 *
 * A client resolves ONE address, out of {@link ClientRegistry}, from this `svcName`. A destination
 * that is DATA instead — a URL a partner registered, a per-tenant host, an OAuth callback — is not
 * a second KIND of config; it is a per-call edit made by a filter (`ContextBaseUrlFilter`), through
 * the same seam an app's own header-rewriting or logging filter uses. Naming the two as alternative
 * config shapes made a second extension mechanism sitting beside the filter chain and doing the
 * same job, which is exactly the shape this repo rejects.
 */
export class ClientConfig {
    constructor(
        /**
         * The service name, and the ONE thing that decides where this client points.
         *
         * The URL is DERIVED from it (on GCP: same project, same region — the Cloud Run service
         * name, so you maintain no URL table), which works across demo/qa/prod. Anything the
         * derivation cannot describe — a localhost port, another region/project, a non-Cloud-Run
         * host — is a `ClientRegistry` mapping registered at startup, NOT a per-client URL.
         *
         * It is also this client's IDENTITY on the runtime architecture graph. For a client that a
         * `ContextBaseUrlFilter` re-points per call, the graph identity comes from the CONTRACT's
         * `@externalSystem` tag instead, which is where the fact "this hop leaves our estate"
         * belongs — on the contract every caller of it shares, not on one construction site.
         */
        public readonly svcName: string,
    ) {}
}
