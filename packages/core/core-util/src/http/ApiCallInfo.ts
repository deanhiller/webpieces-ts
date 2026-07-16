import { ApiMethodInfo } from './ApiMethodInfo';

/**
 * ApiCallInfo - the structured tag stamped into RequestContext around every API call
 * (by {@link LogApiCall}), so ANY log line emitted during the call inherits a filterable
 * `api` object rather than only the req/resp text lines.
 *
 * The node logging backends (winston/bunyan) read this struct out of context via
 * `RequestContext.buildStructuredLogFields()` and emit it AS AN OBJECT under `jsonPayload.api`,
 * which unlocks GCP Cloud Logging filters like:
 * - `jsonPayload.api.method.side="client"`     — every outbound call this process made
 * - `jsonPayload.api.method.side="server"`      — every inbound call it handled
 * - `jsonPayload.api.method.apiClass="SaveApi"` — one logical method, BOTH sides (client + server)
 * - `jsonPayload.api.result="failure"`          — failed exchanges only
 * - `jsonPayload.api:*`                          — "API traffic only" (tracing + the recorder)
 *
 * IMPORTANT: the field names here (and on the nested {@link ApiMethodInfo}) ARE the GCP field names —
 * rename a field and the filter renames with it. The identity lives NESTED under `api.method`
 * (`api.method.{side,apiClass,methodName,controllerName}`); `api.type` and `api.result` sit at the top.
 *
 * NOTE: the request `httpMethod`/`path` are NOT here — an inbound request stamps them as the separate
 * top-level logged keys `jsonPayload.httpMethod` / `jsonPayload.requestPath` (see
 * {@link WebpiecesCoreHeaders} + `RequestContextHeaders.fillFromRequest`). Outbound client calls have
 * no inbound path, so they carry only the `api` identity.
 *
 * Per-hop only: the underlying `API_CALL_INFO` ContextKey is NOT transferred over the wire, so a
 * downstream server stamps its own `side:'server'` rather than inheriting the caller's `side:'client'`.
 *
 * Per CLAUDE.md: data-only structures are classes, not interfaces.
 */

/** Which half of the exchange this tag describes: the outgoing 'request' or the returning 'response'. */
export type ApiType = 'request' | 'response';

/**
 * Response outcome. 'success' covers 2xx AND user errors (400/401/403/404/266 — a successfully
 * handled "you made a mistake"); 'failure' is a genuine server error. See {@link LogApiCall.isUserError}.
 */
export type ApiResult = 'success' | 'failure';

/** Re-exported from {@link ApiMethodInfo} (its true home) so existing `ApiSide` imports keep working. */
export type { ApiSide } from './ApiMethodInfo';

export class ApiCallInfo {
    constructor(
        /** The call identity (side, apiClass, methodName, controllerName) — surfaces nested under
         *  `jsonPayload.api.method`. */
        readonly method: ApiMethodInfo,
        readonly type: ApiType,
        /** Response only — undefined on the 'request' tag. */
        readonly result?: ApiResult,
    ) {}
}
