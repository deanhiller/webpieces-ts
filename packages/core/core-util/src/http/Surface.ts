/**
 * WHICH KIND OF CALLER is driving this request, all the way from the edge.
 *
 * The same endpoint can be reached by a browser GUI, by an LLM through the MCP bridge, and by an
 * external partner against a published REST contract. "Does an end-user error render as 266 or as a
 * real 4xx" is therefore a property of the CALLER, not of the server — which is why the per-router
 * `setEndUserStatus` this replaced could never express it: one router serves all three.
 *
 * webpieces already knows which, from the auth mode that matched the incoming request:
 *
 * | how the request authenticated | surface      |
 * |-------------------------------|--------------|
 * | `@WpAuthJwt`                  | `gui`        |
 * | `@WpMcpAuthJwt` (MCP bridge)  | `llm`        |
 * | `@WpAuthApiKey`               | `public-api` |
 *
 * It is set at the EDGE ONLY and then PROPAGATES: the surface is the ORIGINAL caller's, so a hop that
 * already received one INHERITS it unchanged. `@WpAuthOidc` is an internal service-to-service hop, not
 * a surface of its own, and must never overwrite a propagated value — `GUI -> api1 -> api2` leaves
 * api2 seeing `gui`, which is the whole point of carrying it.
 */
export type Surface = 'gui' | 'llm' | 'public-api';

/**
 * The ONE derivation of "what HTTP status does an `ApiEndUserError` publish on this request" — the
 * per-request replacement for the deleted per-router `EndUserStatus`.
 *
 * - `gui` and `llm` -> **266**. Both are webpieces clients that DECODE the body: a browser client
 *   reconstructs the typed `ApiEndUserError`, and the MCP bridge calls through `ApiFactory` and
 *   renders the result for the model itself. A real 4xx would throw away the message either one is
 *   there to show.
 * - `public-api` -> the status the THROW SITE published (`ApiEndUserError.edgeHttpStatus`, else 400),
 *   because a partner's REST contract promises real statuses and has no webpieces client to decode
 *   anything.
 * - **absent** -> 266, the historical default, so a public endpoint or a non-webpieces caller behaves
 *   exactly as it did before this key existed.
 */
export class SurfaceEndUserStatus {
    // webpieces-disable no-function-outside-class -- stateless per-request derivation, no state to hold
    static statusFor(surface: Surface | undefined, edgeHttpStatus: number | undefined): number {
        if (surface === 'public-api') {
            return edgeHttpStatus ?? 400;
        }
        return 266;
    }
}
