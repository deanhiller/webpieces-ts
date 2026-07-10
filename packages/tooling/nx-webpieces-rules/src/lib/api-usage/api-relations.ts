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

/** Transport of an API contract: synchronous RPC (HTTP) vs fire-and-forget PubSub (Cloud Tasks). */
export type ApiTransport = 'rpc' | 'pubsub';

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

/** A discovered API contract class: its name, the api-lib project that owns it, and its transport. */
export interface ApiClassInfo {
    api: string;
    owner: string;
    type: ApiTransport;
}

/** Derive the relation kind from the (possibly empty) implements/uses ref lists. */
// webpieces-disable no-function-outside-class -- pure data helper for these serialization DTOs
export function deriveApiRelationKind(implementsRefs: ApiRef[], usesRefs: ApiRef[]): ApiRelationKind {
    if (implementsRefs.length > 0 && usesRefs.length > 0) return 'uses-implements';
    if (implementsRefs.length > 0) return 'implements';
    return 'uses';
}

/** Stable-sort a ref list by api name so the committed JSON is deterministic. */
// webpieces-disable no-function-outside-class -- pure data helper for these serialization DTOs
export function sortApiRefs(refs: ApiRef[]): ApiRef[] {
    return [...refs].sort((a: ApiRef, b: ApiRef) => a.api.localeCompare(b.api));
}
