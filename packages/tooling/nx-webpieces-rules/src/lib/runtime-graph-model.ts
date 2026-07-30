/**
 * Runtime Graph model
 *
 * The serialization DTOs for architecture/runtime-dependencies.json. Split out of runtime-graph.ts,
 * which owns the DERIVATION (and had grown past the file-size limit), so the committed data shape
 * can be read on its own — it is what every consumer of the file, and any future Terraform
 * cross-check, actually programs against.
 *
 * Interfaces rather than classes: these are parsed straight out of JSON with `JSON.parse`, so a
 * class would only ever be a shape assertion over a plain object, never a constructed instance.
 */

import type { ApiTransport } from './api-usage/api-relations';

export interface RuntimeService {
    level: number;
    /**
     * The name clients address this service by (`new ClientConfig('helper-fsdb')`), declared in its
     * project.json. Absent for a service nothing calls by name (e.g. a browser app).
     */
    serviceName?: string;
    /**
     * The service(s) this node's clients call when the call site carries no literal `ClientConfig`,
     * declared in its project.json (metadata.webpieces.callsService). A single name, or an
     * `{ apiClassName: serviceName }` map. Absent when the node declares no target. Mirrors
     * GraphEntry.callsService; it is the CALLING-side counterpart of `serviceName`.
     */
    callsService?: string | Record<string, string>;
    implements: string[];
    /**
     * apiClassName -> the LIBRARY project whose apiRelations declared that implements, for the apis
     * this service serves through an embedded library rather than its own source (e.g. a shared
     * route-registration lib). Answers "who implements WarmupApi, and where did that come from?",
     * which previously required walking the dependsOn closure by hand.
     */
    implementsVia?: Record<string, string>;
    uses: string[];
    dependsOn: string[];
    /**
     * When false, this service is hidden from the rendered runtime graph (its
     * node AND every edge touching it are omitted from the HTML/DOT). It stays
     * in runtime-dependencies.json so the data view is complete. Absent means
     * drawn (the default). Mirrors GraphEntry.drawOnGraph from the `drawOnGraph:`
     * nx tag.
     */
    drawOnGraph?: boolean;
}

export interface RuntimeApi {
    implementedBy: string[];
    usedBy: string[];
    /** Transport of this API — 'rpc' (direct call) or 'pubsub' (delivered through a queue). */
    type?: ApiTransport;
    /**
     * The api-lib project that OWNS this contract. For a contract nothing in-repo implements, this
     * is the external library the calls leave the repo through (`lib-firestore`, `lib-gmail`), which
     * is what the runtime viz labels its terminal external nodes with.
     */
    owner?: string;
}

export interface RuntimeEdge {
    from: string;
    to: string;
    via: string[];
    /**
     * Transport of this edge. 'rpc' → a direct call arrow. 'pubsub' → the producer enqueues and the
     * consumer is delivered later, so the runtime viz draws it as producer → QUEUE → consumer.
     * Edges are split by transport, so every edge is a single kind.
     */
    type?: ApiTransport;
    /**
     * `"ApiClassName.methodName"` — the queue this edge flows through. Present iff `type` is
     * 'pubsub'. Queues are per METHOD, not per service pair, because that is the unit Cloud Tasks
     * (and Terraform) actually create, so two services exchanging three queued methods are three
     * queues rather than one arrow.
     */
    queue?: string;
}

/**
 * One Cloud Tasks queue: the async seam between a producer and a consumer, at METHOD granularity.
 *
 * `producedBy` and `consumedBy` are deliberately not symmetric in confidence — see
 * {@link ApiRef.methodsInferred}. The consumer is derived from `addRoutes` plus the contract's
 * method table and is exact; the producer is attributed to every queued method of the contract it
 * built a client for, because which methods it enqueues is not statically recoverable.
 */
export interface RuntimeQueue {
    api: string;
    method: string;
    /** `@Queue(...)` override, else `${Api}-${method}` — the name Terraform must match 1:1. */
    queueName: string;
    producedBy: string[];
    consumedBy: string[];
}

/**
 * An endpoint driven by something that is NOT an in-repo caller — a clock or an outside system.
 * These never appear as runtime EDGES (there is no in-repo `from`), which is exactly why they were
 * invisible until now: a nightly sweep and a GCP push subscription are real runtime entry points
 * with real Terraform behind them, and the graph showed neither.
 */
export interface RuntimeTrigger {
    /** 'cron' → a scheduler fires it; 'external' → a system outside this repo posts to it. */
    kind: 'cron' | 'external';
    api: string;
    method: string;
    /** The service that SERVES the endpoint (the arrow's head). */
    service: string;
    /** Present for 'cron': the Cloud Scheduler job / queue name Terraform must match. */
    queueName?: string;
}

export interface RuntimeUnresolved {
    service: string;
    api: string;
}

export interface RuntimeGraph {
    services: Record<string, RuntimeService>;
    apis: Record<string, RuntimeApi>;
    runtimeEdges: RuntimeEdge[];
    unresolvedUses: RuntimeUnresolved[];
    /** `"Api.method"` -> the queue between its producers and its consumers. */
    queues: Record<string, RuntimeQueue>;
    /** Clock- and outside-driven entry points, sorted for determinism. */
    triggers: RuntimeTrigger[];
}
