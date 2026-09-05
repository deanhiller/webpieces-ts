import {
    AnyContextKey,
    DestinationTrust,
    HeaderRegistry,
    RecorderKeys,
    ServiceInfo,
    TestCaseRecorder,
    WebpiecesCoreHeaders,
} from '@webpieces/core-util';
import { provideFrameworkSingleton } from './frameworkProvide';
import { PendingWireTrust } from './PendingWireTrust';
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
export class RequestContextHeaders {
    /**
     * Every transferred key with a non-empty value THAT THIS DESTINATION MAY RECEIVE, under its wire
     * name. Nothing is rewritten.
     *
     * That includes `x-request-id`, which propagates unchanged: one id correlates the whole call
     * tree, so the callee keeps ours rather than minting its own. ({@link fillFromRequest} only
     * generates an id when the inbound request carries none.)
     *
     * TRUSTED keys are the exception, and `destination` is why this method takes an argument at all.
     * The callee's `AuthFilter` admits an inbound `x-user-id` only on a route that authenticated its
     * CALLER, so shipping one to a `@Public` / `@AuthJwt` endpoint builds a request the callee is
     * obliged to 401. {@link DestinationTrust} answers that from the destination endpoint's own
     * AuthMode — there is no "send everything" default to fall into. Untrusted keys always travel.
     *
     * Values are RAW (unmasked) — this map goes on the wire, not in logs.
     *
     * @throws Error when called outside `RequestContext.run(...)` — see the class doc.
     */
    buildOutboundHeaders(destination: DestinationTrust): Map<string, string> {
        this.requireActiveContext();

        const headers = new Map<string, string>();
        // getTransferredKeys() is precomputed at configure() time.
        for (const key of HeaderRegistry.get().getTransferredKeys()) {
            if (!destination.allows(key)) {
                continue;
            }
            // getTransferredKeys() is AnyContextKey[] — mixed in both value type and trust — so this
            // reads through getAny (serialization to the wire, not a trust decision) and narrows with
            // the typeof-string guard; every transferred value is a wire string.
            const value = RequestContext.getAny(key);
            if (typeof value === 'string' && value !== '') {
                headers.set(key.httpHeader!, value);
            }
        }

        // CLIENT_VERSION is transferred, but each hop sends ITS OWN build version (not the inherited
        // one) so a downstream server logs which build actually called it. Overwrite whatever the loop
        // copied from an inbound clientVersion with ours; if THIS service has no version, drop it
        // rather than forward the caller's as if it were ours. Non-throwing read — absent before setInfo.
        const myVersion = ServiceInfo.getVersion();
        const clientVersionHeader = WebpiecesCoreHeaders.CLIENT_VERSION.httpHeader!;
        if (myVersion) {
            headers.set(clientVersionHeader, myVersion);
        } else {
            headers.delete(clientVersionHeader);
        }

        return headers;
    }

    /**
     * INBOUND — the exact inverse of {@link buildOutboundHeaders}. Publish the request, move every
     * transferrable header off it into the context (read by wire name, stored under the key's
     * `name`), and mint an `x-request-id` if the caller sent none.
     *
     * The request is a PARAMETER, not something we fish back out of the context. This method publishes the fully built request and fills the context together. Express also
     * publishes metadata before parsing, so early error translators can inspect the request path;
     * that earlier publication intentionally does not transfer headers or mint a request id.
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

        // Stamp the inbound method+path as top-level logged keys (jsonPayload.httpMethod / requestPath)
        // so EVERY log line of this request carries them. Sourced from the just-published HttpRequest;
        // NOT transferred over the wire, so a downstream hop stamps its own inbound values.
        RequestContext.putUntrusted(WebpiecesCoreHeaders.HTTP_METHOD, request.method);
        RequestContext.putUntrusted(WebpiecesCoreHeaders.REQUEST_PATH, request.path);

        // getTransferredKeys() is precomputed at configure() time.
        for (const key of HeaderRegistry.get().getTransferredKeys()) {
            const values = request.getHeaderValues(key);
            if (values && values.length > 0) {
                this.acceptInbound(key, values[0]);
            }
        }

        if (!RequestContext.hasKey(WebpiecesCoreHeaders.REQUEST_ID)) {
            RequestContext.putUntrusted(WebpiecesCoreHeaders.REQUEST_ID, this.generateRequestId());
            this.stampRequestIdSource();
        }
    }

    /**
     * ONE inbound header -> the context, routed by the key's TRUST.
     *
     * An untrusted key goes straight in — nobody was ever going to make a security decision on it.
     *
     * A TRUSTED key does NOT. This transport-level fill runs BEFORE any filter, so at this instant
     * nothing has verified who the caller is; writing the value now would mean `getTrusted` could
     * return a header a stranger typed. It is stashed in {@link PendingWireTrust} instead and
     * admitted (or rejected) by `AuthFilter`, which knows the route's auth mode. See that class for
     * the full rationale — this two-step is the reason trusted keys can safely keep an `httpHeader`
     * and therefore the reason service-to-service identity propagation works at all.
     *
     * There is NO cast here, on EITHER branch. `isTrusted()` is a type predicate over the
     * {@link AnyContextKey} union, so the `if` holds a trusted key and the `else` holds an untrusted
     * one — the runtime check produces the type it proves. Trust is binary and the union has exactly
     * two constituents, so the `else` is the whole remaining case rather than a silent drop.
     */
    private acceptInbound(key: AnyContextKey, value: string): void {
        if (key.isTrusted()) {
            PendingWireTrust.stash(key, value);
        } else {
            RequestContext.putUntrusted(key, value);
        }
    }

    /**
     * Record that WE minted the id — only ever called from the generate branch above, so the key is
     * ABSENT on a hop that inherited the caller's id. Present == this service is the trace's origin.
     *
     * Uses the non-throwing `getName()`: this runs PER REQUEST, and a missing log field must not 500
     * live traffic. A server that booted already ran `setupRuntime`, which calls `ServiceInfo.setInfo`
     * with its required name+version, so the name is always there in practice; only a test driving the
     * context directly sees undefined.
     */
    private stampRequestIdSource(): void {
        const svcName = ServiceInfo.getName();
        if (svcName) {
            RequestContext.putUntrusted(WebpiecesCoreHeaders.REQUEST_ID_SOURCE, svcName);
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
        return RequestContext.getUntrusted<TestCaseRecorder>(RecorderKeys.RECORDER);
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
