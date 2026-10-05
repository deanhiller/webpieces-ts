import { provideFrameworkSingleton, RequestContext } from '@webpieces/core-context';
import { ApiBadRequestError, ApiImplementationError, Filter, Service } from '@webpieces/core-util';
import { AuthorizationService } from '../AuthorizationHook';
import { MethodMeta } from '../MethodMeta';
import { WpResponse } from '../WpResponse';

/** Receiving-server enforcement follows successful authentication and trust reconciliation. */
@provideFrameworkSingleton()
// webpieces-disable no-any-unknown -- response DTO is erased at the framework filter boundary
export class AuthorizationFilter extends Filter<MethodMeta, WpResponse<unknown>> {
    constructor(private readonly authorization: AuthorizationService) {
        super();
    }

    // webpieces-disable no-any-unknown -- framework filters accept any endpoint's response DTO
    override async filter(meta: MethodMeta, next: Service<MethodMeta, WpResponse<unknown>>): Promise<WpResponse<unknown>> {
        const policy = meta.routeMeta.authorization;
        if (!policy) throw new ApiImplementationError(`Endpoint ${meta.routeMeta.path} requires @WpAuthorization.`);
        await this.authorization.authorize(policy);
        const parseError = RequestContext.getRequest()?.raw?.bodyParseError;
        if (parseError) throw new ApiBadRequestError('Request body is not valid JSON', undefined, undefined, parseError);
        return next.invoke(meta);
    }
}
