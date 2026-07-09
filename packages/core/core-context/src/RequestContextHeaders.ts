import { injectable } from 'inversify';
import {
    HeaderRegistry,
    RecorderKeys,
    TestCaseRecorder,
    WebpiecesCoreHeaders,
} from '@webpieces/core-util';
import { provideFrameworkSingleton } from './frameworkProvide';
import { HttpRequest } from './HttpRequest';
import { RequestContext } from './RequestContext';

/**
 * RequestContextHeaders - the magic context ↔ the wire, for a SERVER. Both directions live here:
 *
 *   inbound   {@link fillFromRequest}       the published HttpRequest's headers -> the context
 *   outbound  {@link buildOutboundHeaders}  the context -> the next hop's headers
 *
 * Reads the AsyncLocalStorage-backed {@link RequestContext} straight through — no ContextReader,
 * no ContextMgr, no abstract base. A server has exactly one place its context lives, and the
 * indirection only hid the failure below. (The browser's answer is `ContextMgr` in
 * @webpieces/core-util, which reads an app-held store because a browser has no ambient scope.)
 *
 * FAILS FAST outside a RequestContext. Silently sending an outbound call with NO request id or
 * tenant is far worse than a loud error — the trace just disappears and you find out in production. Every server-side client (RPC and Cloud Tasks) therefore only works
 * inside `RequestContext.run(...)`, which a top-level server filter normally establishes for you.
 *
 * Stateless once built, so it binds as a framework singleton every server-side client shares.
 */
@provideFrameworkSingleton()
@injectable()
export class RequestContextHeaders {
    /**
     * EVERY transferred key with a non-empty value, under its wire name. Nothing is rewritten.
     *
     * That includes `x-request-id`, which propagates unchanged: one id correlates the whole call
     * tree, so the callee keeps ours rather than minting its own. ({@link fillFromRequest} only
     * generates an id when the inbound request carries none.)
     *
     * Values are RAW (unmasked) — this map goes on the wire, not in logs.
     *
     * @throws Error when called outside `RequestContext.run(...)` — see the class doc.
     */
    buildOutboundHeaders(): Map<string, string> {
        this.requireActiveContext();

        const headers = new Map<string, string>();
        // getTransferredKeys() is precomputed at configure() time.
        for (const key of HeaderRegistry.get().getTransferredKeys()) {
            const value = RequestContext.getHeader<string>(key);
            if (value !== undefined && value !== null && value !== '') {
                headers.set(key.httpHeader!, value);
            }
        }

        return headers;
    }

    /**
     * INBOUND — the exact inverse of {@link buildOutboundHeaders}. Publish the request, move every
     * transferrable header off it into the context (read by wire name, stored under the key's
     * `name`), and mint an `x-request-id` if the caller sent none.
     *
     * The request is a PARAMETER, not something we fish back out of the context. Publishing and
     * filling are therefore one atomic step that cannot be half-done or done out of order — the
     * older `setRequest()` + `fillContext()` pair could silently skip the transfer entirely when a
     * caller forgot the first half.
     *
     * This is a PRECONDITION of calling into http-routing, and it belongs ABOVE the api boundary.
     * `WebpiecesMiddleware` does it for every HTTP request; a non-webpieces transport (or a test
     * driving `createApiClient` directly) must do the same. The api proxy only checks that a
     * request scope exists — it never builds one.
     *
     * @throws Error when called outside `RequestContext.run(...)`.
     */
    fillFromRequest(request: HttpRequest): void {
        this.requireActiveContext();

        RequestContext.setRequest(request);

        // getTransferredKeys() is precomputed at configure() time.
        for (const key of HeaderRegistry.get().getTransferredKeys()) {
            const values = request.getHeaderValues(key);
            if (values && values.length > 0) {
                RequestContext.putHeader(key, values[0]);
            }
        }

        if (!RequestContext.hasHeader(WebpiecesCoreHeaders.REQUEST_ID)) {
            RequestContext.putHeader(WebpiecesCoreHeaders.REQUEST_ID, this.generateRequestId());
        }
    }

    /** The id every log line of this request, and every downstream hop, will carry. */
    private generateRequestId(): string {
        return `svrGenReqId-${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;
    }

    /**
     * The recorder travelling in the context, when a test is recording this call. Absent in normal
     * operation, and ALWAYS absent in a browser — which is why recording lives on the server-side
     * client and never in the isomorphic core.
     */
    findRecorder(): TestCaseRecorder | undefined {
        if (!RequestContext.isActive()) {
            return undefined;
        }
        return RequestContext.getHeader<TestCaseRecorder>(RecorderKeys.RECORDER);
    }

    /** Guard both directions: no ambient request scope means there is no context to fill or read. */
    private requireActiveContext(): void {
        if (!RequestContext.isActive()) {
            throw new Error(
                'No active RequestContext. A webpieces server-side client only works inside ' +
                'RequestContext.run(...), which a top-level server filter normally establishes. ' +
                'In a test, wrap the call: await RequestContext.run(async () => client.foo(req));',
            );
        }
    }
}
