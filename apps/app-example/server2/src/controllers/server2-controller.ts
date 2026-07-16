import { injectable, bindingScopeValues } from 'inversify';
import { DocumentDesign } from '@webpieces/http-routing';
import { RequestContext } from '@webpieces/core-context';
import { WebpiecesCoreHeaders } from '@webpieces/core-util';
import { Server2Api, FetchValueRequest, FetchValueResponse } from '@webpieces/server2-api';
import { CompanyHeaders } from '@webpieces/company-core';
import { GreetingService } from '../services/GreetingService';

/**
 * Server2Controller - Serves the Server2Api over real HTTP.
 *
 * Echoes the magic-context headers it received back into the response value so
 * callers (and the two-hop integration test) can SEE the context transfer:
 * - requestId proves the caller's x-request-id arrived UNCHANGED — one id per call tree
 * - tenant proves company headers transfer end-to-end
 */
@injectable(bindingScopeValues.Singleton)
@DocumentDesign()
export class Server2Controller extends Server2Api {
    // Inject-by-type: GreetingService is @injectable(Singleton) and self-binds under the app
    // container's autobind, so Inversify resolves this parameter by its concrete class alone —
    // one decorator, no Symbol token, no @inject, no @provideSingleton.
    constructor(private readonly greetingService: GreetingService) {
        super();
    }

    override async fetchValue(request: FetchValueRequest): Promise<FetchValueResponse> {
        const requestId = RequestContext.getHeader(WebpiecesCoreHeaders.REQUEST_ID);
        const tenant = RequestContext.getHeader(CompanyHeaders.TENANT_ID);
        const greeting = this.greetingService.greet(request.name);

        return {
            value: `server2:name=${request.name};greeting=${greeting};requestId=${requestId};tenant=${tenant}`,
            timestamp: Date.now(),
        };
    }
}
