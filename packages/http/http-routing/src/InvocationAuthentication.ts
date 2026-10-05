import { RequestContext } from '@webpieces/core-context';
import { ApiImplementationError, RouteMetadata } from '@webpieces/core-util';
import { AuthenticatedCallerContext } from './AuthenticatedCallerContext';

/** Token-free local entry, bound to the verified ingress scope and one actual endpoint. */
export class InvocationAuthentication {
    private readonly scopeIdentity: object;

    constructor(private readonly apiClass: Function, private readonly methodName: string) {
        if (!AuthenticatedCallerContext.hasEstablishedIngress()) {
            throw new ApiImplementationError('Local invocation requires completed verified ingress.');
        }
        this.scopeIdentity = RequestContext.activeScopeIdentity();
    }

    assertTarget(route: RouteMetadata): void {
        if (this.scopeIdentity !== RequestContext.activeScopeIdentity() ||
            !AuthenticatedCallerContext.hasEstablishedIngress() ||
            route.apiClass !== this.apiClass || route.methodName !== this.methodName) {
            throw new ApiImplementationError('Local invocation authentication belongs to a different target or request scope.');
        }
    }
}
