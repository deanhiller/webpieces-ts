import { RouterRequest } from './RouterRequest';
import { RouterResponse } from './RouterResponse';

/**
 * RouterReqResp - Wraps RouterRequest and RouterResponse together.
 *
 * Provides a single object that filters and routing logic can use
 * to access both request and response without depending on Express.
 *
 * This is the abstraction that gets passed through the filter chain,
 * allowing filters to read request data and write response data in
 * an Express-independent way.
 */
export class RouterReqResp {
    constructor(
        /**
         * The request abstraction (wraps Express req).
         */
        public readonly request: RouterRequest,

        /**
         * The response abstraction (wraps Express res).
         */
        public readonly response: RouterResponse
    ) {}
}
