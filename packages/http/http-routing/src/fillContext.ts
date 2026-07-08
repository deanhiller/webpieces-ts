import { RequestContext } from '@webpieces/core-context';
import { HeaderRegistry, WebpiecesCoreHeaders } from '@webpieces/core-util';

/**
 * fillContext - ABOVE-the-boundary context setup, shared by every transport (the express
 * adapter AND the in-process client). Call it once, inside RequestContext.run() and after
 * RequestContext.setRequest(httpRequest): it transfers the platform/context headers from the
 * HttpRequest into RequestContext (for logging + outbound propagation) and ensures a REQUEST_ID.
 *
 * This is the old below-boundary ContextFilter's job, moved above the api boundary so the raw
 * request never has to survive as a chain filter — the fixed error/auth filters and the
 * controller run below, reading the already-populated context (and the HttpRequest for auth).
 */
export function fillContext(): void {
    const request = RequestContext.getRequest();
    const registry = HeaderRegistry.get();

    if (request) {
        // Transfer each transferred key (read by wire name, store under key.name).
        for (const key of registry.getTransferredKeys()) {
            const values = request.getHeaderValues(key);
            if (values && values.length > 0) {
                RequestContext.putHeader(key, values[0]);
            }
        }
    }

    if (!RequestContext.hasHeader(WebpiecesCoreHeaders.REQUEST_ID)) {
        RequestContext.putHeader(WebpiecesCoreHeaders.REQUEST_ID, generateRequestId());
    }
}

function generateRequestId(): string {
    return `svrGenReqId-${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;
}
