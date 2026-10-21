import { ApiMethodInfo } from './ApiMethodInfo';
import { MaskSpec } from './LogFieldMask';

/**
 * ApiCallInfo - the structured tag stamped into RequestContext around every API call
 * (by {@link LogApiCallImpl}), so ANY log line emitted during the call inherits a filterable
 * `api` object rather than only the req/resp text lines.
 *
 * The node logging backends (winston/bunyan) read this struct out of context via
 * `RequestContext.buildStructuredLogFields()` and emit it AS AN OBJECT under `jsonPayload.api`,
 * which unlocks GCP Cloud Logging filters like:
 * - `jsonPayload.api.method.side="client"`     — every outbound call this process made
 * - `jsonPayload.api.method.side="server"`      — every inbound call it handled
 * - `jsonPayload.api.method.apiClass="SaveApi"` — one logical method, BOTH sides (client + server)
 * - `jsonPayload.api.result="failure"`          — failed exchanges only
 * - `jsonPayload.api.durationMs>1000`           — slow calls, either side
 * - `jsonPayload.api.responseSize>100000`       — the fat responses (the ones that get chunked)
 * - `jsonPayload.api.responseCount>100`         — responses containing many logical items
 * - `jsonPayload.api:*`                          — "API traffic only" (tracing + the recorder)
 * - `jsonPayload.api.http.status=404`            — an HTTP client call the vendor answered 404 (#1339)
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
/**
 * Which HALF of one api call a log line describes.
 *
 * Renamed from `ApiType`, which collided with the `@ApiType(...)` CONTRACT decorator and read as if
 * it were about the kind of API rather than the direction of one line. Per
 * `.claude/rules/no-backwards-compat.md` the old spelling is deleted rather than aliased, so a caller
 * on the old name stops compiling and the error names this one.
 */
export type ApiCallDirection = 'request' | 'response';

/**
 * Response outcome. 'success' covers 2xx AND user errors (400/401/403/404/266 — a successfully
 * handled "you made a mistake"); 'failure' is a genuine server error. `success` = {@link CallOutcome.EXPECTED} from {@link ApiRegistry.classify}.
 */
export type ApiResult = 'success' | 'failure';

/** Re-exported from {@link ApiMethodInfo} (its true home) so existing `ApiSide` imports keep working. */
export type { ApiSide } from './ApiMethodInfo';

/**
 * The HTTP facts of ONE client call's last transmission — surfaces as `jsonPayload.api.http.*`.
 * Filled ONLY by the HTTP client (node and browser), which is the one layer that has a verb, a url
 * and a status; in-process, pubsub and cloud-task calls leave {@link ApiCallInfo.http} unset. It
 * exists because a vendor's 404 and its 500 were indistinguishable in the logs when only the DTOs
 * were recorded.
 *
 * Never headers or tokens: the url is MASKED ({@link maskUrl}) before it gets here.
 */
export class HttpCallFacts {
    constructor(
        /** The HTTP verb, e.g. `GET`. */
        readonly method: string,
        /** The final absolute url, masked: no userinfo, and `@MaskLog` field names' query values redacted. */
        readonly url: string,
        /** The status of the last response received. */
        readonly status: number,
    ) {}

    /**
     * The url as it may be logged: any `user:password@` userinfo is dropped, and the value of every
     * query key the endpoint's `@MaskLog` names is replaced with `*****` (a `?token=` the DTO mask
     * already hides must not reappear in the url).
     */
    // webpieces-disable no-function-outside-class -- pure static helper beside the data it builds
    static maskUrl(url: string, mask: MaskSpec | undefined): string {
        const withoutUserInfo = url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@?#]*@/i, '$1');
        const queryAt = withoutUserInfo.indexOf('?');
        if (queryAt < 0 || mask === undefined) return withoutUserInfo;
        const query = withoutUserInfo
            .slice(queryAt + 1)
            .split('&')
            .map((pair: string) => {
                const equals = pair.indexOf('=');
                const key = equals < 0 ? pair : pair.slice(0, equals);
                return mask.modeFor(HttpCallFacts.decode(key)) === undefined ? pair : `${key}=*****`;
            })
            .join('&');
        return `${withoutUserInfo.slice(0, queryAt)}?${query}`;
    }

    // webpieces-disable no-function-outside-class -- pure static helper beside the data it builds
    private static decode(key: string): string {
        // A malformed escape is logged as written; it can never be a masked field name anyway.
        return /%(?![0-9a-f]{2})/i.test(key) ? key : decodeURIComponent(key);
    }
}

/**
 * The per-call slot the HTTP client fills with {@link HttpCallFacts} as each response arrives, and
 * {@link LogApiCallImpl} reads when it stamps the response tag. A holder rather than a return value
 * because the facts are known DEEP in the transport while the tag is written at the top of the call;
 * the last transmission (after redirects, a 401 refresh or a retry) wins.
 */
export class HttpCallFactsHolder {
    facts: HttpCallFacts | undefined = undefined;
}

export class ApiCallInfo {
    constructor(
        /** The call identity (side, apiClass, methodName, controllerName) — surfaces nested under
         *  `jsonPayload.api.method`. */
        readonly method: ApiMethodInfo,
        readonly type: ApiCallDirection,
        /** Response only — undefined on the 'request' tag. */
        readonly result?: ApiResult,
        /**
         * Wall-clock milliseconds the call took. RESPONSE tag only (undefined on 'request') — a
         * request has no duration yet. Present on BOTH the success and failure paths, so
         * `jsonPayload.api.durationMs>1000 AND api.result="failure"` finds slow failures.
         *
         * There is deliberately no top-level `statusCode` beside this. LogApiCall runs deep in the
         * stack over in-process calls, pubsub handlers, and cloud-task enqueues — none of which have
         * an HTTP status — and business logic must not know about HTTP. `result` (see {@link ApiResult})
         * is the transport-neutral outcome, exactly as {@link ApiRegistry.classify} (a {@link CallOutcome}) classifies by
         * portable Error TYPE rather than by status code. That decision STANDS (#1339): the HTTP
         * client's status lives in the optional, nested {@link http} — present only where there IS an
         * HTTP exchange, so nothing transport-neutral ever reads it.
         */
        readonly durationMs?: number,
        /**
         * Bytes of the serialized request DTO. Stamped on BOTH tags: the 'request' tag reports it as
         * soon as it is known, and the 'response' tag repeats it so one record shows the whole
         * exchange (`api.requestSize` + `api.responseSize` without a join).
         *
         * This is the TOTAL size of the body, measured BEFORE any log chunking — chunking is a
         * transport concern handled by the GCP backends, and a body split across 3 records still
         * reports its one true size here.
         */
        readonly requestSize?: number,
        /** Bytes of the serialized response. RESPONSE tag only, and only when the call succeeded —
         *  a thrown error produced no response body to measure. Total size, pre-chunking. */
        readonly responseSize?: number,
        /** Number of logical items in a successful response. RESPONSE tag only, opt-in per call. */
        readonly responseCount?: number,
        /**
         * The HTTP verb, masked url and status of the call's last transmission — `jsonPayload.api.http.*`.
         * RESPONSE tag only, and only for a call made by the HTTP client (success AND failure, so
         * `api.result="failure" AND api.http.status=429` finds a vendor throttling us). Unset for
         * in-process, pubsub and cloud-task calls. See {@link HttpCallFacts}.
         */
        readonly http?: HttpCallFacts,
    ) {}
}
