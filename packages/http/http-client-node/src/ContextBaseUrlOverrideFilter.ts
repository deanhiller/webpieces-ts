import { Filter, Service, WebpiecesCoreHeaders } from '@webpieces/core-util';
import { RequestContext } from '@webpieces/core-context';
import { ClientRequest } from '@webpieces/http-client-core';

/**
 * Reads {@link WebpiecesCoreHeaders.OVERRIDE_BASE_URL} out of the ambient RequestContext and points
 * THIS ONE CALL at it.
 *
 * This is the filter the whole runtime-base-URL feature is built out of, and expressing it as a
 * filter rather than as a special case inside the transport is the point: information from OUTSIDE
 * the call (a URL a partner registered, sitting in a database column) crosses into the send path
 * through the same seam an app's own signing filter uses, and everything below it in the chain —
 * the SSRF guard, the app's signature — sees the destination this filter chose rather than the one
 * `ClientConfig` bound at construction.
 *
 * ## Scope, and why it cannot leak
 *
 * It mutates the per-call {@link ClientRequest} and nothing else. The client is untouched, so the
 * next call through the same client starts from its configured host again; and the context entry is
 * scoped to whatever `RequestContext.run(...)` the caller established, so a fan-out loop that sets a
 * different URL per partner gets exactly the URL it set, per iteration.
 *
 * It is installed ONLY by the runtime host policies, so a client bound to a deployed service never
 * reads the key at all. That is what stops an ambient value set for a partner delivery from silently
 * re-pointing every other client in the same request at the partner's server.
 *
 * Priority {@link BASE_URL_OVERRIDE_PRIORITY} — the OUTERMOST framework filter, so the destination
 * is settled before anything else looks at it.
 */
export class ContextBaseUrlOverrideFilter extends Filter<ClientRequest, Response> {
    override async filter(request: ClientRequest, nextFilter: Service<ClientRequest, Response>): Promise<Response> {
        const override = RequestContext.getUntrusted(WebpiecesCoreHeaders.OVERRIDE_BASE_URL);
        if (override === undefined || override === '') {
            throw new Error(
                `${request.contractName}.${request.route.methodName} is a RUNTIME-HOST client, so its ` +
                    `destination must be supplied per call, but no ` +
                    `WebpiecesCoreHeaders.OVERRIDE_BASE_URL was found in the RequestContext. Set it around ` +
                    `the call:\n` +
                    `    RequestContext.putUntrusted(WebpiecesCoreHeaders.OVERRIDE_BASE_URL, webhook.url);\n` +
                    `Refusing rather than falling back to a derived service URL is deliberate: a silent ` +
                    `fallback would send a partner's payload to one of our own services.`,
            );
        }
        request.pointAtBaseUrl(override);
        return nextFilter.invoke(request);
    }
}

/**
 * The priority the override filter runs at — OUTERMOST of everything, because every other filter's
 * job depends on knowing where the call is going. Exported so an app can see what it is ordering
 * against rather than guessing at a magic number.
 */
export const BASE_URL_OVERRIDE_PRIORITY = 1000;

/** The SSRF guard's priority: immediately inside the override, so it judges the URL that won. */
export const SSRF_GUARD_PRIORITY = 900;
