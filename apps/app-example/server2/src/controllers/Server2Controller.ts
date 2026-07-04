import { Controller, provideSingleton } from '@webpieces/http-routing';
import { RequestContext } from '@webpieces/core-context';
import { WebpiecesCoreHeaders } from '@webpieces/http-api';
import { Server2Api, FetchValueRequest, FetchValueResponse } from '@webpieces/server2-api';
import { CompanyHeaders } from '@webpieces/company-core';

/**
 * Server2Controller - Serves the Server2Api over real HTTP.
 *
 * Echoes the magic-context headers it received back into the response value so
 * callers (and the two-hop integration test) can SEE the context transfer:
 * - previousId proves the caller's x-request-id arrived as x-previous-request-id
 *   (per-hop request-id chaining)
 * - requestId proves this hop got its own fresh id
 * - tenant proves company headers transfer end-to-end
 */
@provideSingleton()
@Controller()
export class Server2Controller extends Server2Api {
    override async fetchValue(request: FetchValueRequest): Promise<FetchValueResponse> {
        const requestId = RequestContext.getHeader(WebpiecesCoreHeaders.REQUEST_ID);
        const previousId = RequestContext.getHeader(WebpiecesCoreHeaders.PREVIOUS_REQUEST_ID);
        const tenant = RequestContext.getHeader(CompanyHeaders.TENANT_ID);

        return {
            value: `server2:name=${request.name};requestId=${requestId};previousId=${previousId};tenant=${tenant}`,
            timestamp: Date.now(),
        };
    }
}
