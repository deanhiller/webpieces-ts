import { ClientRegistry } from '@webpieces/core-util';

/** Constructor whose prototype is T (the abstract @PubSub API class). */
export type ApiPrototype<T> = Function & { prototype: T };

/**
 * Per-client STATE for a Cloud Tasks enqueue client — nothing else.
 *
 * Collaborators (TaskInvoker, RequestContextHeaders) are NOT config: they are dependencies of
 * {@link ClientCloudTasksFactory} and shared by every client it builds. This is the fire-and-forget
 * twin of http-client-node's ClientConfig, and takes the same single field.
 */
export class TaskClientConfig {
    constructor(
        /**
         * The service name. On GCP the URL is DERIVED from it (same project, same region — the Cloud
         * Run service name, so you maintain no URL table), which works across demo/qa/prod. Anything
         * the derivation cannot describe — a localhost port, another region/project, a non-Cloud-Run
         * host — is a `ClientRegistry` mapping registered at startup, NOT a per-client URL.
         */
        public readonly svcName: string,
    ) {}

    /**
     * Resolved per enqueue, not at construction — so building a client stays synchronous.
     *
     * This goes through {@link ClientRegistry.resolve}, the SAME chain (mapping, else deriver, else
     * throw) the RPC client runs. Cloud Tasks does not go through `ProxyClient.resolveBaseUrl()`, so
     * it has to reach the chain itself — otherwise enqueue targets drift from call targets.
     */
    resolveUrl(): Promise<string> {
        return ClientRegistry.resolve(this.svcName);
    }
}
