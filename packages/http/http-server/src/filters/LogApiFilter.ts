import { injectable } from 'inversify';
import {provideFrameworkSingleton, MethodMeta} from '@webpieces/http-routing';
import { Filter, WpResponse, Service } from '@webpieces/http-routing';
import { LogManager } from '@webpieces/core-util';
import { LogApiCall, ApiMethodInfo } from '@webpieces/core-util';

/**
 * LogApiFilter - Structured API logging for all requests/responses.
 * Priority: 1800 (after ContextFilter at 2000, before custom filters)
 *
 * Logging patterns (via LogApiCall):
 * - [API-server-req] Class.method /url request={...}
 * - [API-server-resp-SUCCESS] Class.method response={...}
 * - [API-server-resp-FAIL] Class.method error=... (server errors: 500, 502, 504)
 * - [API-server-resp-OTHER] Class.method errorType=... (user errors: 400, 401, 403, 404, 266)
 *
 * Headers are read from RequestContext (NOT from meta.requestHeaders which is undefined
 * after ContextFilter runs at priority 2000).
 *
 * User errors (HttpBadRequestError, etc.) are logged as OTHER, not FAIL,
 * because they are expected behavior from the server's perspective.
 */
const log = LogManager.getLogger('LogApiFilter');

@provideFrameworkSingleton()
@injectable()
export class LogApiFilter extends Filter<MethodMeta, WpResponse<unknown>> {

    async filter(
        meta: MethodMeta,
        nextFilter: Service<MethodMeta, WpResponse<unknown>>,
    ): Promise<WpResponse<unknown>> {
        // Wrap nextFilter.invoke in a method that returns the response
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
