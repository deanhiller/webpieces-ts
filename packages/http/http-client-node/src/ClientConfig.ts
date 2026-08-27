import { HostPolicy } from './HostPolicy';

/**
 * Per-client STATE for a server-side HTTP client — nothing else. A plain class; it extends nothing
 * and is unrelated to the browser package's ClientConfig, because the two answer "what URL?"
 * differently and share nothing worth a base class.
 *
 * Collaborators (RequestContextHeaders, Secrets) are NOT config: they are dependencies of
 * {@link NodeProxyClient} and are shared by every client the factory builds. Outbound FILTERS are
 * not config either — they are per-client collaborators an app constructs, so they are the third
 * argument to `createRpcClient` rather than a field here.
 */
export class ClientConfig {
    constructor(
        /**
         * The service name.
         *
         * Under {@link DeployedServiceHost} the URL is DERIVED from it (on GCP: same project, same
         * region — the Cloud Run service name, so you maintain no URL table), which works across
         * demo/qa/prod. Anything the derivation cannot describe — a localhost port, another
         * region/project, a non-Cloud-Run host — is a `ClientRegistry` mapping registered at
         * startup, NOT a per-client URL.
         *
         * Under a runtime host policy nothing is derived from it, but it is still required and still
         * load-bearing: it is the IDENTITY this outbound hop gets on the runtime architecture graph
         * ('partner-webhooks'), which is what stops a partner delivery being an invisible edge.
         */
        public readonly svcName: string,
        /**
         * WHERE this client's requests go: a service we deploy, or a host supplied per call at
         * runtime. REQUIRED — see {@link HostPolicy} for why there is no default. The old
         * one-argument `new ClientConfig('svc')` no longer compiles; write
         * `new ClientConfig('svc', new DeployedServiceHost())` for the behaviour it used to have.
         */
        public readonly hostPolicy: HostPolicy,
    ) {}
}
