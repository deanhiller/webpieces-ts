/**
 * ApiCallInfo - the structured tag stamped into RequestContext around every API call
 * (by {@link LogApiCall}), so ANY log line emitted during the call inherits a filterable
 * `api` object rather than only the req/resp text lines.
 *
 * The node logging backends (winston/bunyan) read this struct out of context via
 * `RequestContext.buildStructuredLogFields()` and emit it AS AN OBJECT under `jsonPayload.api`,
 * which unlocks GCP Cloud Logging filters like:
 * - `jsonPayload.api.side="client"`   — every outbound call this process made
 * - `jsonPayload.api.side="server"`   — every inbound call it handled
 * - `jsonPayload.api.result="failure"`— failed exchanges only
 * - `jsonPayload.api:*`               — "API traffic only" (tracing + the recorder)
 *
 * IMPORTANT: the field names on this class ARE the GCP field names (`api.side`, `api.type`,
 * `api.result`, `api.path`, `api.method`, `api.controller`) — rename a field here and the filter
 * renames with it.
 *
 * Per-hop only: the underlying `API_CALL_INFO` ContextKey is NOT transferred over the wire, so a
 * downstream server stamps its own `side:'server'` rather than inheriting the caller's `side:'client'`.
 *
 * Per CLAUDE.md: data-only structures are classes, not interfaces.
 */

/** Which end of the exchange this process is: the caller ('client') or the handler ('server'). */
export type ApiSide = 'client' | 'server';

/** Which half of the exchange this tag describes: the outgoing 'request' or the returning 'response'. */
export type ApiType = 'request' | 'response';

/**
 * Response outcome. 'success' covers 2xx AND user errors (400/401/403/404/266 — a successfully
 * handled "you made a mistake"); 'failure' is a genuine server error. See {@link LogApiCall.isUserError}.
 */
export type ApiResult = 'success' | 'failure';

export class ApiCallInfo {
    constructor(
        readonly side: ApiSide,
        readonly type: ApiType,
        /** Response only — undefined on the 'request' tag. */
        readonly result?: ApiResult,
        readonly path?: string,
        readonly method?: string,
        /** The controller/API class name (e.g. 'SaveController') — filter with jsonPayload.api.controller. */
        readonly controller?: string,
    ) {}
}
