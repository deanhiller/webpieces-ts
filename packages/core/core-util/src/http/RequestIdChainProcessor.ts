import { WebpiecesCoreHeaders } from './WebpiecesCoreHeaders';

/**
 * RequestIdChainProcessor - Builds the per-hop distributed-trace chain.
 *
 * TS equivalent of the Java MicroSvcHeader REQUEST_ID/PREVIOUS_REQUEST_ID flow:
 * when a server makes an outbound call, its CURRENT request id is sent to the
 * downstream service as x-previous-request-id, and x-request-id is NOT sent -
 * the downstream ContextFilter then generates a fresh id for its own hop.
 * Result: every hop has its own id plus a pointer to its caller's id, forming
 * a trace tree.
 *
 * Invoked by ContextMgr.buildOutboundHeaders() after the transferred headers
 * are collected. Opt out via `new ContextMgr(reader, registry, false)` if you
 * want raw pass-through of x-request-id instead.
 */
export class RequestIdChainProcessor {
    /**
     * Rewrite the outbound header map in place: x-request-id -> x-previous-request-id.
     */
    process(outboundHeaders: Map<string, string>): void {
        const requestIdName = WebpiecesCoreHeaders.REQUEST_ID.headerName;
        const previousIdName = WebpiecesCoreHeaders.PREVIOUS_REQUEST_ID.headerName;

        const currentRequestId = outboundHeaders.get(requestIdName);
        if (currentRequestId === undefined) {
            return;
        }

        outboundHeaders.set(previousIdName, currentRequestId);
        outboundHeaders.delete(requestIdName);
    }
}
