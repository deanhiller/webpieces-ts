import { provideFrameworkSingleton, RequestContext } from '@webpieces/core-context';
import { LogManager, WebpiecesCoreHeaders, LogApiCall, ApiMethodInfo } from '@webpieces/core-util';
import { Filter, WpResponse, Service } from '../Filter';
import { MethodMeta } from '../MethodMeta';

/**
 * LogApiFilter - the OUTERMOST fixed framework filter (auto-installed at priority 1,000,000 on
 * every route, above AuthFilter). It logs the request AND the response/failure for EVERY call —
 * over HTTP or via createApiClient — and stamps the routed controller identity so every log line
 * of the request carries [Controller.method].
 *
 * Being outermost is deliberate: a request rejected by AuthFilter (401), or any other below-it
 * filter, is STILL logged here with its request body and controller identity. (The former
 * ErrorLogFilter sat above auth but logged only a bare error line — no request, no identity;
 * LogApiFilter replaces it and subsumes its error-logging via LogApiCall.)
 *
 * Logging patterns (via LogApiCall):
 * - [API-server-req] Class.method request={...}
 * - [API-server-resp-SUCCESS] Class.method response={...}
 * - [API-server-resp-FAIL] Class.method error=... (server errors: 500, 502, 504)
 * - [API-server-resp-OTHER] Class.method errorType=... (user errors: 400, 401, 403, 404, 266)
 *
 * User errors (HttpUnauthorizedError, HttpBadRequestError, etc.) are logged as OTHER, not FAIL,
 * because they are expected behavior from the server's perspective. LogApiCall re-throws the
 * error unchanged; the transport (express adapter, or another framework's adapter) maps
 * HttpError subclasses → HTTP status, so in-process and HTTP paths log identically.
 *
 * Headers are read from RequestContext (NOT from meta.requestHeaders which is undefined
 * after ContextFilter runs).
 */
const log = LogManager.getLogger('LogApiFilter');

@provideFrameworkSingleton()
// webpieces-disable no-any-unknown -- Filter generic params use unknown for response flexibility
export class LogApiFilter extends Filter<MethodMeta, WpResponse<unknown>> {

    // webpieces-disable no-any-unknown -- Filter generic params use unknown for response flexibility
    async filter(
        meta: MethodMeta,
        nextFilter: Service<MethodMeta, WpResponse<unknown>>,
    ): Promise<WpResponse<unknown>> {
        // Wrap nextFilter.invoke in a method that returns the response
        // webpieces-disable no-any-unknown -- response DTO is erased at the api/proxy boundary
        const method = async (): Promise<unknown> => {
            const wpResponse = await nextFilter.invoke(meta);
            return wpResponse.response;
        };

        // LogApiCall is a singleton (use it directly, no `new`). It logs the text lines AND stamps the
        // structured `api={method:{side:'server',...},...}` tag into RequestContext, so every log line
        // during the request carries jsonPayload.api. Correlation fields (requestId, ...) are added by
        // the backend. apiClass is the CONTRACT name (routeMeta.apiName, e.g. 'SaveApi') so a server log
        // line MATCHES the client's for the same call; controllerName keeps the impl (e.g. 'SaveController').
        const rm = meta.routeMeta;

        // Stamp the routed endpoint's IMPLEMENTATION identity onto the request context so EVERY log line
        // of this request (not just the api req/resp lines) carries the concrete controller class +
        // handler method name — what you actually grep for, and more useful than the raw requestPath. GCP
        // gets them as separate jsonPayload.controller / jsonPayload.method; the local console formatters
        // render them together as a compact [Controller.method] bracket. They clear with the request scope.
        if (rm.controllerClassName) {
            RequestContext.putHeader(WebpiecesCoreHeaders.CONTROLLER, rm.controllerClassName);
        }
        if (rm.methodName) {
            RequestContext.putHeader(WebpiecesCoreHeaders.METHOD, rm.methodName);
        }

        const info = new ApiMethodInfo(
            'server',
            rm.apiName ?? rm.controllerClassName ?? 'Unknown',
            rm.methodName,
            rm.controllerClassName,
        );
        const response = await LogApiCall.execute(info, meta.requestDto, method);
        return new WpResponse(response);
    }
}
