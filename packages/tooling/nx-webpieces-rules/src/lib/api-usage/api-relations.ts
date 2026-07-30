/**
 * API Relations model
 *
 * The typed classification of a compile-time dependency edge P -> apiLib in
 * architecture/dependencies.json. Where the flat `dependsOn` only says "P depends
 * on apiLib", `apiRelations[apiLib]` says WHY: which API contracts P IMPLEMENTS
 * (serves, `class Ctrl extends XxxApi`) and which it USES (calls as a client,
 * `factory.createRpcClient(XxxApi, ...)` / `createPubSubClient(...)`), each tagged
 * with its transport.
 *
 * Interfaces + object literals here mirror the sibling runtime-graph.ts model —
 * these are serialization DTOs written verbatim into the committed JSON, and
 * `implements`/`uses` are legal interface property names (they are reserved words
 * only as binding identifiers, not as member names).
 */

/**
 * Transport of an API contract:
 *  - `rpc`      — synchronous request/response over HTTP
 *  - `pubsub`   — fire-and-forget, delivered later through a Cloud Tasks queue
 *  - `external` — a contract for a system OUTSIDE this repo (firestore, gmail, ...). Nothing in-repo
 *                 implements it, so it never becomes a service→service edge; it terminates the graph
 *                 at a dashed vendor node. Detected from `runtime-architecture.externalApiPaths`
 *                 rather than from a decorator, because a vendor contract is a plain interface bound
 *                 to a Symbol token, not an `abstract class` carrying @ApiPath.
 */
export type ApiTransport = 'rpc' | 'pubsub' | 'external';

/**
 * How a project relates to ONE api-lib it depends on:
 *  - `implements`       — it serves the api (a controller extends it)
 *  - `uses`             — it calls the api (generates a client)
 *  - `uses-implements`  — it does BOTH (implements some of the api-lib's contracts,
 *                          uses others)
 */
export type ApiRelationKind = 'implements' | 'uses' | 'uses-implements';

/** One API class a project implements or uses, with its transport. */
export interface ApiRef {
    api: string;
    type: ApiTransport;
    /**
     * ONLY on a `uses` ref: the service the call site aims at, read from the client config literal
     * (`createRpcClient(XxxApi, new ClientConfig('helper-fsdb'))` → `helper-fsdb`). It is matched
     * against a project's DECLARED `serviceName` to pick the ONE runtime edge target, instead of
     * fanning the edge out to every implementer of the api — which is catastrophically wrong for a
     * company-wide contract registered in a shared library and therefore implemented by every server.
     *
     * Absent when the config argument is not a `new <Xxx>ClientConfig('<literal>')` (a variable, a
     * computed name, ...). Absent means "unknown target", NOT "no target" — the runtime graph then
     * falls back to the old fan-out and says so out loud.
     */
    targetService?: string;
    /**
     * ONLY on a `pubsub` uses ref. True means "this producer was attributed to EVERY cloudtasks
     * method of the contract, not to the methods it actually enqueues".
     *
     * A producer builds one client for the whole contract (`createPubSubClient(EmailTaskApi, cfg)`)
     * and enqueues through a proxy (`emailTasks.send(req)`) somewhere else entirely — often after
     * the client has been stored in a DI binding — so WHICH methods it enqueues is not statically
     * recoverable. The consumer side IS exact (addRoutes + the contract's method table). Recording
     * the difference keeps a producer-side queue from being read as proof that queue is used.
     */
    methodsInferred?: boolean;
}

/**
 * Identity of a ref for de-duplication: an api used twice against DIFFERENT services is two distinct
 * relations (two distinct runtime edges), so the api name alone is not the key.
 */
// webpieces-disable no-function-outside-class -- pure data helper for these serialization DTOs
export function apiRefKey(ref: ApiRef): string {
    return `${ref.api} ${ref.targetService ?? ''}`;
}

/**
 * A project's relationship to ONE api-lib it depends on. Serialized verbatim into
 * architecture/dependencies.json under `apiRelations[apiLibProjectName]`.
 */
export interface ApiRelation {
    kind: ApiRelationKind;
    implements: ApiRef[];
    uses: ApiRef[];
}

/** apiLibProjectName -> relation. Attached to a GraphEntry as `apiRelations`. */
export type ProjectApiRelations = Record<string, ApiRelation>;

/**
 * What triggers ONE endpoint, mirroring core-util's `EndpointKind`. Duplicated as a string union
 * rather than imported: nx-webpieces-rules is build tooling and must not take a runtime dependency
 * on the framework it inspects (it reads decorators as TEXT, from projects that may be on a
 * different @webpieces version than the tooling itself).
 */
export type EndpointKind = 'rpc' | 'cloudtasks' | 'cron' | 'external';

/**
 * One method on an API contract, as written in source: what triggers it, where it is mounted, and
 * (for a queued method) which Cloud Tasks queue delivers it.
 */
export interface ApiMethodMeta {
    name: string;
    /** The @Endpoint path, relative to the class's @ApiPath basePath. */
    path: string;
    kind: EndpointKind;
    /**
     * `@Queue(...)` override, else `${ApiClassName}-${methodName}`. Present for every method so a
     * `cron` schedule and a `cloudtasks` queue are both nameable; Terraform matches on this string.
     */
    queueName: string;
}

/**
 * A discovered API contract class: its name, the api-lib project that owns it, its transport, and
 * its per-method trigger table.
 */
export interface ApiClassInfo {
    api: string;
    owner: string;
    type: ApiTransport;
    /** The class's @ApiPath basePath; absent for an external (vendor) contract, which has no route. */
    basePath?: string;
    /**
     * Every @Endpoint method, in declaration order. Empty for an external contract (a vendor
     * interface has no endpoints — it is called through a vendor SDK, not mounted).
     */
    methods: ApiMethodMeta[];
}

/**
 * The committed, per-contract view written to `architecture/dependencies.json` under `apiContracts`.
 *
 * The runtime graph is derived SOLELY from dependencies.json so generate and validate can never
 * diverge — which means anything the runtime graph needs must be COMMITTED there, not re-scanned.
 * Per-method trigger kinds and queue names are exactly that: without this table the derivation
 * cannot tell a queued endpoint from a cron sweep, and cannot name the queue between two services.
 */
export interface ApiContract {
    owner: string;
    /** 'rpc' | 'pubsub' for an in-repo contract, 'external' for a vendor seam. */
    apiKind: ApiTransport;
    basePath?: string;
    methods: ApiMethodMeta[];
}

/** apiClassName -> its committed contract. Serialized as the `apiContracts` key. */
export type ApiContracts = Record<string, ApiContract>;

/** Derive the relation kind from the (possibly empty) implements/uses ref lists. */
// webpieces-disable no-function-outside-class -- pure data helper for these serialization DTOs
export function deriveApiRelationKind(implementsRefs: ApiRef[], usesRefs: ApiRef[]): ApiRelationKind {
    if (implementsRefs.length > 0 && usesRefs.length > 0) return 'uses-implements';
    if (implementsRefs.length > 0) return 'implements';
    return 'uses';
}

/**
 * Stable-sort a ref list by api name, then by target service, so the committed JSON is
 * deterministic even when one api is used against two different services.
 */
// webpieces-disable no-function-outside-class -- pure data helper for these serialization DTOs
export function sortApiRefs(refs: ApiRef[]): ApiRef[] {
    return [...refs].sort(
        (a: ApiRef, b: ApiRef) =>
            a.api.localeCompare(b.api) || (a.targetService ?? '').localeCompare(b.targetService ?? ''),
    );
}
