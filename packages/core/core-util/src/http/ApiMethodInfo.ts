/**
 * ApiMethodInfo - the transport-neutral identity of a single API method call, handed to
 * {@link LogApiCall.execute} by every caller (server inbound, http/in-process clients, cloud tasks,
 * and external wrapped clients like the firestore admin client).
 *
 * WHY generic (not RouteMetadata): LogApiCall runs deep in the stack over MANY shapes — HTTP routes,
 * pubsub/queue enqueues, and multi-param external clients returning Promise<void>/Promise<unknown>.
 * None of those own an `httpMethod`/`path`, so LogApiCall must not depend on the HTTP-shaped
 * `RouteMetadata`. This carries only what identifies the call.
 *
 * MATCHING is the point of {@link apiClass}: a CLIENT call and the SERVER handler for the same logical
 * method must log the SAME identity so `jsonPayload.api.method.apiClass="SaveApi"` filters both sides
 * together. The API CONTRACT class name (e.g. 'SaveApi') is available on both sides — the client only
 * ever knows it, and the server carries it alongside its impl name — so it, not the server's impl
 * class, is the required key.
 *
 * Per CLAUDE.md: data-only structures are classes, not interfaces.
 */

/** Which end of the exchange this process is: the caller ('client') or the handler ('server'). */
export type ApiSide = 'client' | 'server';

export class ApiMethodInfo {
    constructor(
        readonly side: ApiSide,
        /** REQUIRED — the API CONTRACT class name (e.g. 'SaveApi'). Matches client + server so both
         *  sides of one logical call filter together via `jsonPayload.api.method.apiClass`. */
        readonly apiClass: string,
        /** REQUIRED — the method on the contract (e.g. 'save'). */
        readonly methodName: string,
        /** OPTIONAL — server-side impl class (e.g. 'SaveController'). Absent on clients, which have no
         *  impl. Surfaces as `jsonPayload.api.method.controllerName` for server-only drill-down. */
        readonly controllerName?: string,
    ) {}
}
