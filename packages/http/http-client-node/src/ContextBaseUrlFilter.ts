import { Filter, Service, WebpiecesCoreHeaders } from '@webpieces/core-util';
import { RequestContext } from '@webpieces/core-context';
import { ClientRequest } from '@webpieces/http-client-core';
import { MissingRuntimeBaseUrlError } from './MissingRuntimeBaseUrlError';
import { SsrfPolicy } from './SsrfPolicy';

/**
 * Reads {@link WebpiecesCoreHeaders.OVERRIDE_BASE_URL} out of the ambient RequestContext and points
 * THIS ONE CALL at it. Ships in the box, and is the whole of the runtime-base-URL feature:
 *
 * ```ts
 * const partner = factory.createRpcClient(PartnerWebhookApi, new ClientConfig('partner-webhooks'), [
 *     new ClientFilterDefinition(1000, new ContextBaseUrlFilter()),
 * ]);
 *
 * for (const webhook of webhooks) {
 *     await RequestContext.run(() => {
 *         RequestContext.putUntrusted(WebpiecesCoreHeaders.OVERRIDE_BASE_URL, webhook.url);
 *         return partner.deliver(envelope);
 *     });
 * }
 * ```
 *
 * ## INSTALLING IT IS THE OPT-IN
 *
 * There is no client-level setting saying "this one may be re-pointed", because installing this
 * filter IS that statement, written at the one place a reader looks. A client with no
 * `ContextBaseUrlFilter` ignores an ambient `OVERRIDE_BASE_URL` entirely — which is what stops a
 * value set for a partner delivery from silently re-pointing every other client in the same
 * request at the partner's server. `grep -rn ContextBaseUrlFilter` enumerates every client in a
 * codebase that can be re-pointed at all, which is the question a security review actually asks.
 *
 * ## PER-ENDPOINT, if a contract mixes them
 *
 * `request.route` carries `methodName`, `path`, `httpMethod` and `authMeta`, so a subclass can
 * re-point some endpoints of a contract and leave the rest on the configured host, with no API
 * change:
 *
 * ```ts
 * class DeliverOnlyBaseUrlFilter extends ContextBaseUrlFilter {
 *     override async filter(request: ClientRequest, next: Service<ClientRequest, Response>) {
 *         if (request.route.methodName !== 'deliver') return next.invoke(request);
 *         return super.filter(request, next);
 *     }
 * }
 * ```
 *
 * ## Scope, and why it cannot leak
 *
 * It mutates the per-call {@link ClientRequest} and nothing else. The client is untouched, so the
 * next call through the same client starts from its configured host again; and the context entry is
 * scoped to whatever `RequestContext.run(...)` the caller established, so a fan-out loop that sets
 * a different URL per partner gets exactly the URL it set, per iteration.
 *
 * ## The SSRF guard is NOT registered here
 *
 * Re-pointing arms it by itself — `ClientRequest.pointAtBaseUrl` flips
 * `destinationCameFromData`, and the framework's own guard sits beneath every app filter and reads
 * that. So this filter cannot forget to bring the guard along, and an app cannot install this one
 * without it. The only thing this class carries is WHICH policy the guard applies, and only
 * because the single legitimate relaxation ({@link SsrfTestingPolicy}) belongs at the same
 * construction site as the decision to be re-pointable at all.
 */
export class ContextBaseUrlFilter extends Filter<ClientRequest, Response> {
    constructor(
        /**
         * What the framework's SSRF guard holds this client's re-pointed URLs to.
         *
         * Defaulted to {@link SsrfPolicy.strict}, and that default is the SAFE branch, so the
         * omitted argument can never be the permissive one — the widening has to be typed out, with
         * a reason, as `new ContextBaseUrlFilter(new SsrfTestingPolicy('<why>'))`.
         */
        readonly ssrfPolicy: SsrfPolicy = new SsrfPolicy(),
    ) {
        super();
    }

    override async filter(request: ClientRequest, nextFilter: Service<ClientRequest, Response>): Promise<Response> {
        const override = RequestContext.getUntrusted(WebpiecesCoreHeaders.OVERRIDE_BASE_URL);
        if (override === undefined || override === '') {
            throw new MissingRuntimeBaseUrlError(
                `${request.contractName}.${request.route.methodName} runs behind a ContextBaseUrlFilter, so ` +
                    `its destination must be supplied per call, but no ` +
                    `WebpiecesCoreHeaders.OVERRIDE_BASE_URL was found in the RequestContext. Set it around ` +
                    `the call:\n` +
                    `    RequestContext.putUntrusted(WebpiecesCoreHeaders.OVERRIDE_BASE_URL, webhook.url);\n` +
                    `Refusing rather than falling back to this client's configured service URL is ` +
                    `deliberate: a silent fallback would send a partner's payload to one of our own services.`,
                `${request.contractName}.${request.route.methodName}`,
            );
        }
        request.pointAtBaseUrl(override);
        return nextFilter.invoke(request);
    }
}
