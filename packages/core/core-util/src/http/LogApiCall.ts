import {RouteMetadata} from "./decorators";
import {
    HttpBadRequestError,
    HttpUnauthorizedError,
    HttpForbiddenError,
    HttpNotFoundError,
    HttpUserError,
} from './errors';
import {toError} from "../lib/errorUtils";
import {LogManager} from "../logging/LogManager";
import {ApiCallInfo, ApiSide} from "./ApiCallInfo";
import {ApiCallContextHolder} from "./ApiCallContext";
import {WebpiecesCoreHeaders} from "./WebpiecesCoreHeaders";

const log = LogManager.getLogger('LogApiCall');

/**
 * Options for {@link LogApiCallImpl.execute}. `allowVoidResponse` opts OUT of the strict
 * falsy-response guard for callers that legitimately return void/undefined (e.g. a local firestore
 * wrapper). Defaults to strict so RPC callers keep the safety net.
 */
export class LogApiCallOptions {
    allowVoidResponse?: boolean;

    constructor(allowVoidResponse?: boolean) {
        this.allowVoidResponse = allowVoidResponse;
    }
}

/**
 * LogApiCall - Generic API call logging utility, used by BOTH server-side (LogApiFilter) and
 * client-side (ProxyClient) for one consistent logging shape across the framework.
 *
 * TWO things happen around each call:
 * 1. Text lines are emitted (the human-readable `[API-...]` patterns below).
 * 2. A structured {@link ApiCallInfo} tag is stamped into the ambient request context via the
 *    {@link ApiCallContextHolder} seam, so EVERY log line emitted during the call (not just the
 *    req/resp lines) inherits a filterable `api` object — surfacing in GCP as
 *    `jsonPayload.api.{side,type,result,path,method}`.
 *
 * BROWSER-SAFE: this lives in core-util and runs in the browser bundle (via ProxyClient →
 * BrowserProxyClient), so it MUST NOT import `RequestContext` (Node async_hooks, and a circular dep).
 * It stamps through the {@link ApiCallContext} seam instead: `setupRuntime` installs a
 * RequestContext-backed impl on a Node server, and `ClientHttpBrowserFactory` a module-global impl in a
 * browser. If neither ran, {@link ApiCallContextHolder.get} throws (loud misconfiguration).
 *
 * Singleton, mirroring `RequestContext`: use the exported {@link LogApiCall} constant, not `new`.
 *
 * Logging format patterns:
 * - [API-{side}-req] ClassName.methodName request={...}
 * - [API-{side}-resp-SUCCESS] ClassName.methodName response={...}
 * - [API-{side}-resp-OTHER] ClassName.methodName errorType={...}  (user errors)
 * - [API-{side}-resp-FAIL] ClassName.methodName error={...}  (server errors)
 */
export class LogApiCallImpl {

    /**
     * Execute an API call with logging + `api` context-tagging around it.
     *
     * @param side - 'client' (outbound call this process made) or 'server' (inbound call it handled)
     * @param meta - Route metadata with controllerClassName and methodName
     * @param requestDto - The request DTO
     * @param method - The method to execute
     * @param options - `allowVoidResponse: true` opts OUT of the strict falsy-response guard, for
     *   callers that legitimately return void/undefined (e.g. a local firestore wrapper whose
     *   `setDocument` returns void, or a `getDocById` miss returning undefined). Defaults to strict,
     *   so RPC callers (LogApiFilter, ProxyClient) keep the safety net: an HTTP endpoint returning
     *   nothing is almost always a bug.
     *
     * Correlation fields (requestId, tenantId, ...) are NOT stamped here — a logging BACKEND owns that,
     * reading RequestContext on every record. What IS stamped here is the per-call `api` tag, and only
     * for the SYNCHRONOUS span of each log line: set → log → remove. Because the tag is never held across
     * `await method(...)`, a concurrent browser call (single-threaded, one global slot) can never clobber
     * it. Cost: only the `[API-*]` req/resp lines carry `api`, not lines emitted mid-call — which is
     * exactly what the GCP filters (`jsonPayload.api.*`) want.
     */
    public async execute(
        side: ApiSide,
        meta: RouteMetadata,
        // webpieces-disable no-any-unknown -- DTO types are erased at the api/proxy boundary (matches ProxyClient)
        requestDto: any,
        // webpieces-disable no-any-unknown -- DTO types are erased at the api/proxy boundary
        method: (dto: any) => Promise<any>,
        options?: LogApiCallOptions
        // webpieces-disable no-any-unknown -- DTO types are erased at the api/proxy boundary
    ): Promise<any> {
        // Throws if no ApiCallContext was installed at startup, or there is no active scope to stamp
        // into (loud misconfiguration — an api call with nowhere to tag is a bug).
        const ctx = ApiCallContextHolder.get();
        if (!ctx.isActive()) {
            throw new Error(
                'LogApiCall requires an ACTIVE ApiCallContext. On a Node server, run inside the ' +
                'RequestContext.run(...) a server filter opens; in a browser, build ClientHttpBrowserFactory first.',
            );
        }
        const key = WebpiecesCoreHeaders.API_CALL_INFO;
        const server = side === 'server';
        const cls = meta.controllerClassName;
        // set → emit → remove, as ONE synchronous span: the tag is live only while the logger reads it,
        // never across an await, so a single browser global slot can never be clobbered by a concurrent call.
        const stamp = (info: ApiCallInfo, emit: () => void): void => {
            ctx.set(key, info);
            emit();
            ctx.remove(key);
        };

        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- LogApiCall logs errors before re-throwing to caller
        try {
            stamp(new ApiCallInfo(side, 'request', undefined, meta.path, meta.methodName, cls), () =>
                log.info(`[API-${side}-req] ${cls}.${meta.methodName} ${meta.path} request=${JSON.stringify(requestDto)}`));

            if(!requestDto)
                throw new Error(`Request cannot be null and was from ${cls}.${meta.methodName}`);

            const response = await method(requestDto);

            if(!options?.allowVoidResponse && !response)
                throw new Error(`Response cannot be null and was from ${cls}.${meta.methodName}`);

            stamp(new ApiCallInfo(side, 'response', 'success', meta.path, meta.methodName, cls), () =>
                log.info(`[API-${side}-resp-SUCCESS] ${cls}.${meta.methodName} response=${JSON.stringify(response)}`));

            return response;
        } catch (err: unknown) {
            const error = toError(err);
            const errorType = error.constructor.name;
            const errorMessage = error.message;
            // Side-dependent: a 4xx the SERVER raised is a handled non-failure (OTHER); the same 4xx a
            // CLIENT receives means its call FAILED. HttpUserError (266) is never a failure, either side.
            const isUser = this.isUserError(error, server);

            stamp(new ApiCallInfo(side, 'response', isUser ? 'success' : 'failure', meta.path, meta.methodName, cls), () =>
                isUser
                    ? log.warn(`[API-${side}-resp-OTHER] ${cls}.${meta.methodName} errorType=${errorType}`)
                    : log.error(`[API-${side}-resp-FAIL] ${cls}.${meta.methodName} errorType=${errorType} error=${errorMessage}`));
            throw error;
        }
    }

    /**
     * Is this error a NON-failure for HEALTH/METRICS — the process working CORRECTLY (log OTHER, api
     * result:'success') — rather than a real failure to surface (log FAIL, result:'failure')?
     *
     * The question is "are things WORKING?", NOT "was it an HTTP 4xx vs 5xx" — and the two are not the
     * same (see 408 below). Classification is by portable Error TYPE, never by transport: LogApiCall runs
     * deep in the stack (in-process calls, pubsub/queue handlers, HTTP — one code path) and only ever
     * sees a thrown Error. The Http* classes are poorly named for that (the `Http` prefix is historical),
     * but they ARE portable error types that travel with the throw anywhere, so matching the TYPE works
     * with or without any HTTP in the picture. Do NOT swap this for an `error.code` 4xx range check — that
     * both re-couples to HTTP AND would bury 408.
     *
     * SERVER — a healthy server correctly rejecting a CLIENT'S mistake is metrics NOISE, not a failure:
     * - HttpBadRequestError (400)   "your request is malformed"
     * - HttpUnauthorizedError (401) "you're not authenticated"
     * - HttpForbiddenError (403)    "authenticated, but not allowed"
     * - HttpNotFoundError (404)     "wrong url / no such entity" (EndpointNotFoundError is a subclass)
     *   → the server is fine, the caller erred → result:'success', logged OTHER.
     *
     * SERVER — something may actually be WRONG, so SURFACE it (result:'failure', logged FAIL):
     * - HttpTimeoutError (408): a 4xx, but the client may NEVER have seen the response — deliberately
     *   absent from the list below so it counts as a failure.
     * - 500 / 502 / 504 / 598, and any non-Http Error: real failures.
     *
     * HttpUserError (266): ALWAYS a non-failure, server OR client — an expected "user made a mistake" signal.
     * CLIENT: receiving ANY error except 266 means the outbound call FAILED → result:'failure'.
     *
     * @param error  - The already-normalized error (callers pass toError(err), never a raw catch value)
     * @param server - True when this side is the SERVER handling an inbound call; false for a CLIENT's outbound call
     * @returns true if this should be treated as a non-failure (OTHER / result:'success')
     */
    isUserError(error: Error, server: boolean): boolean {
        // 266 is the one error that is never a failure, on either side.
        if (error instanceof HttpUserError) {
            return true;
        }
        // A client that RECEIVED any error (except the 266 above) made a failed call.
        if (!server) {
            return false;
        }
        // SERVER: only a healthy rejection of the caller's mistake is a non-failure. Note 408
        // (HttpTimeoutError) is intentionally NOT here — the client may never have seen the response.
        return (
            error instanceof HttpBadRequestError ||
            error instanceof HttpUnauthorizedError ||
            error instanceof HttpForbiddenError ||
            error instanceof HttpNotFoundError
        );
    }
}

/**
 * The process-wide {@link LogApiCallImpl} singleton — mirrors the `RequestContext` export pattern.
 * Callers use `LogApiCall.execute(...)`, never `new`.
 */
export const LogApiCall = new LogApiCallImpl();
