import { injectable } from 'inversify';
import { provideFrameworkSingleton } from '@webpieces/core-context';
import { toError, LogManager } from '@webpieces/core-util';
import { Filter, WpResponse, Service } from '../Filter';
import { MethodMeta } from '../MethodMeta';

const log = LogManager.getLogger('ErrorLogFilter');

/**
 * ErrorLogFilter - the OUTERMOST fixed framework filter (auto-installed above the auth filter on
 * every route). It wraps the whole chain in a try/catch so EVERY failure — over HTTP or via
 * createApiClient — is logged once WITH the request context (correlation/request id, etc.) that
 * RequestContextHeaders.fillFromRequest() established above the boundary.
 *
 * It re-throws the error unchanged; the transport (express adapter, or another framework's
 * adapter) maps HttpError subclasses → HTTP status. Being a below-boundary filter means the
 * in-process path gets the same consistent logging the HTTP path always had.
 */
@provideFrameworkSingleton()
@injectable()
// webpieces-disable no-any-unknown -- Filter generic params use unknown for response flexibility
export class ErrorLogFilter extends Filter<MethodMeta, WpResponse<unknown>> {
    // webpieces-disable no-any-unknown -- Filter generic params use unknown for response flexibility
    override async filter(
        meta: MethodMeta,
        nextFilter: Service<MethodMeta, WpResponse<unknown>>,
    ): Promise<WpResponse<unknown>> {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- fixed boundary filter: log every failure with context, then re-throw for the transport to translate to a status
        try {
            return await nextFilter.invoke(meta);
        } catch (err: unknown) {
            const error = toError(err);
            log.error(`[${meta.httpMethod} ${meta.path}] ${error.name}: ${error.message}`, error);
            throw error;
        }
    }
}
