import { injectable } from 'inversify';
import { provideSingleton, MethodMeta } from '@webpieces/http-routing';
import { RequestContext } from '@webpieces/core-context';
import { Filter, WpResponse, Service } from '@webpieces/http-filters';
import { HttpUnauthorizedError } from '@webpieces/http-api';
import { CompanyHeaders } from '../modules/CompanyModule';

/**
 * AuthFilter - Example auth enforcement filter (app-level, NOT framework).
 * Priority: 1900 (after ContextFilter 2000, before LogApiFilter 1800)
 *
 * Reads authMeta from MethodMeta to decide auth requirements:
 * - authenticated=false → public, no check
 * - authenticated=true → requires AUTHORIZATION header in RequestContext
 * - authenticated=true + roles → requires AUTHORIZATION + matching roles
 *
 * authMeta is guaranteed non-undefined by ApiRoutingFactory startup validation.
 *
 * In a real app, this would parse JWT tokens, validate OAuth, etc.
 * This example just checks for header presence.
 */
@provideSingleton()
@injectable()
// webpieces-disable no-any-unknown -- Filter generic params use unknown for response type flexibility
export class AuthFilter extends Filter<MethodMeta, WpResponse<unknown>> {

    // webpieces-disable no-any-unknown -- Filter generic params use unknown for response type flexibility
    async filter(
        meta: MethodMeta,
        nextFilter: Service<MethodMeta, WpResponse<unknown>>,
    ): Promise<WpResponse<unknown>> {
        const authMeta = meta.authMeta;

        if (!authMeta || !authMeta.authenticated) {
            // Public endpoint — no auth check needed
            return await nextFilter.invoke(meta);
        }

        // Authenticated endpoint — check for auth token
        const token = RequestContext.getHeader(CompanyHeaders.AUTHORIZATION);
        if (!token) {
            throw new HttpUnauthorizedError('Authentication required');
        }

        // If roles specified, a real app would extract roles from JWT and compare
        // For this example, we just verify the token exists

        return await nextFilter.invoke(meta);
    }
}
