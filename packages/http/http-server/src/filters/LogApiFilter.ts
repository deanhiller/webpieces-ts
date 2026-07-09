import { injectable } from 'inversify';
import {provideFrameworkSingleton, MethodMeta} from '@webpieces/http-routing';
import { Filter, WpResponse, Service } from '@webpieces/http-routing';
import { LogManager } from '@webpieces/core-util';
import {
    ContextKey,
    HeaderRegistry,
    LogApiCall,
} from '@webpieces/core-util';

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
const log = LogManager.getLogger('LogApiFilter');

@provideFrameworkSingleton()
@injectable()
export class LogApiFilter extends Filter<MethodMeta, WpResponse<unknown>> {
    private logApiCall: LogApiCall;
    private loggedKeys: ContextKey[];

    constructor() {
        super();

        // The global registry is the single source of truth (configured at startup,
        // duplicate-validated). Log map keys off each key's `name`.
        this.loggedKeys = HeaderRegistry.get().getLoggedKeys();

        log.info(`[LogApiFilter] Using ${this.loggedKeys.length} logged context keys from HeaderRegistry`);

        this.logApiCall = new LogApiCall();
    }

    async filter(
        meta: MethodMeta,
        nextFilter: Service<MethodMeta, WpResponse<unknown>>,
    ): Promise<WpResponse<unknown>> {
        // Wrap nextFilter.invoke in a method that returns the response
        const method = async (): Promise<unknown> => {
            const wpResponse = await nextFilter.invoke(meta);
            return wpResponse.response;
        };

        const response = await this.logApiCall.execute("SVR", meta.routeMeta, meta.requestDto, method);
        return new WpResponse(response);
    }
}
