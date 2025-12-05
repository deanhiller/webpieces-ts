import {inject, injectable, multiInject, optional} from 'inversify';
import {provideSingleton, MethodMeta, RequestContextReader} from '@webpieces/http-routing';
import { Filter, WpResponse, Service } from '@webpieces/http-filters';
import {
    PlatformHeader,
    PlatformHeadersExtension,
    HeaderMethods,
    HEADER_TYPES,
    LogApiCall,
} from '@webpieces/http-api';

/**
 * LogApiFilter - Structured API logging for all requests/responses.
 * Priority: 1800 (after ContextFilter at 2000, before custom filters)
 *
 * Logging patterns (via LogApiCall):
 * - [API-SVR-req] Class.method /url request={...} headers={...}
 * - [API-SVR-resp-SUCCESS] Class.method response={...}
 * - [API-SVR-resp-FAIL] Class.method error=... (server errors: 500, 502, 504)
 * - [API-SVR-resp-OTHER] Class.method errorType=... (user errors: 400, 401, 403, 404, 266)
 *
 * Headers are read from RequestContext (NOT from meta.requestHeaders which is undefined
 * after ContextFilter runs at priority 2000).
 *
 * User errors (HttpBadRequestError, etc.) are logged as OTHER, not FAIL,
 * because they are expected behavior from the server's perspective.
 */
@provideSingleton()
@injectable()
export class LogApiFilter extends Filter<MethodMeta, WpResponse<unknown>> {
    private logApiCall: LogApiCall;
    private allHeaders: PlatformHeader[];

    constructor(
        @multiInject(HEADER_TYPES.PlatformHeadersExtension) @optional()
        extensions: PlatformHeadersExtension[] = [],
        @inject(HeaderMethods) private headerMethods: HeaderMethods
    ) {
        super();

        // Flatten all headers from all extensions
        this.allHeaders = [];
        for (const extension of extensions) {
            this.allHeaders.push(...extension.getHeaders());
        }

        this.logApiCall = new LogApiCall();
    }

    async filter(
        meta: MethodMeta,
        nextFilter: Service<MethodMeta, WpResponse<unknown>>,
    ): Promise<WpResponse<unknown>> {
        // Build header map from RequestContext (headers are already masked for secure values)
        const contextReader = new RequestContextReader();
        const headers = this.headerMethods.buildSecureMapForLogs(this.allHeaders, contextReader);

        // Wrap nextFilter.invoke in a method that returns the response
        const method = async (): Promise<unknown> => {
            const wpResponse = await nextFilter.invoke(meta);
            return wpResponse.response;
        };

        const response = await this.logApiCall.execute("SVR", meta.routeMeta, meta.requestDto, headers, method);
        return new WpResponse(response);
    }
}
