import { resolveTargetUrl } from '@webpieces/gcp-identity';

/** Constructor whose prototype is T (the abstract @PubSub API class). */
export type ApiPrototype<T> = Function & { prototype: T };

/**
 * Per-client STATE for a Cloud Tasks enqueue client — nothing else.
 *
 * Collaborators (TaskInvoker, RequestContextHeaders) are NOT config: they are dependencies of
 * {@link ClientCloudTasksFactory} and shared by every client it builds. This is the fire-and-forget
 * twin of http-client-node's ClientConfig, and takes the same two fields.
 */
export class TaskClientConfig {
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

    /** Resolved per enqueue, not at construction — so building a client stays synchronous. */
    resolveTargetUrl(): Promise<string> {
        return resolveTargetUrl(this.svcName, this.targetUrl);
    }
}
