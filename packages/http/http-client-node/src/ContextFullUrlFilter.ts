import { Filter, Service, WebpiecesCoreHeaders } from '@webpieces/core-util';
import { RequestContext } from '@webpieces/core-context';
import { ClientRequest } from '@webpieces/http-client-core';
import { MissingRuntimeBaseUrlError } from './MissingRuntimeBaseUrlError';
import { SsrfPolicy } from './SsrfPolicy';

/**
 * Reads {@link WebpiecesCoreHeaders.OVERRIDE_FULL_URL} out of the ambient RequestContext and sends
 * THIS ONE CALL to that url, VERBATIM — host, path and query exactly as stored, with the contract's
 * own path NOT appended. This is the filter for the common partner-webhook shape, where the partner
 * gave us one opaque url (a database row) rather than implementing our contract at their host:
 *
 * ```ts
 * const partner = factory.createRpcClient(PartnerWebhookApi, new ClientConfig('partner-webhooks'), [
 *     new ClientFilterDefinition(1000, new ContextFullUrlFilter()),
 * ]);
 *
 * for (const webhook of webhooks) {
 *     await RequestContext.run(() => {
 *         // e.g. 'https://hooks.partner.example/in/abc?token=xyz' — sent byte for byte
 *         RequestContext.putUntrusted(WebpiecesCoreHeaders.OVERRIDE_FULL_URL, webhook.url);
 *         return partner.deliver(envelope);
 *     });
 * }
 * ```
 *
 * The contract can therefore declare an honest path (`@ApiPath('/webhook')` + `@Endpoint(POST, '/deliver', ...)`)
 * for documentation and the architecture graph, knowing it is replaced per call.
 *
 * ## Why a SEPARATE filter from ContextBaseUrlFilter
 *
 * The two answer different questions. `ContextBaseUrlFilter` swaps the HOST and keeps this route's
 * path (a tenant running our contract at their own server); this one swaps the WHOLE url. A flag on
 * one filter would be two behaviours behind one name, and `grep -rn ContextFullUrlFilter` would no
 * longer list exactly the clients whose destination is a stored url.
 *
 * ## Everything else is ContextBaseUrlFilter's contract, unchanged
 *
 * - **Installing it is the opt-in.** A client without it ignores an ambient `OVERRIDE_FULL_URL`.
 * - **It refuses rather than falls back.** No override in scope throws
 *   {@link MissingRuntimeBaseUrlError}; it never sends to the client's configured service URL,
 *   which would deliver a partner's payload to one of our own services.
 * - **It cannot leak.** Only the per-call {@link ClientRequest} is mutated.
 * - **The SSRF guard is armed by the act of re-pointing.** `ClientRequest.pointAtFullUrl` flips
 *   `destinationCameFromData`; this class carries only WHICH policy applies, so the one relaxation
 *   (`SsrfTestingPolicy`) is named at the same construction site as the decision to be re-pointable.
 */
export class ContextFullUrlFilter extends Filter<ClientRequest, Response> {
    constructor(
        /**
         * What the framework's SSRF guard holds this client's re-pointed URLs to. Defaulted to the
         * strict {@link SsrfPolicy}, so the omitted argument is never the permissive one — widening
         * has to be typed out as `new ContextFullUrlFilter(new SsrfTestingPolicy('<why>'))`.
         */
        readonly ssrfPolicy: SsrfPolicy = new SsrfPolicy(),
    ) {
        super();
    }

    override async filter(
        request: ClientRequest,
        nextFilter: Service<ClientRequest, Response>,
    ): Promise<Response> {
        const override = RequestContext.getUntrusted(WebpiecesCoreHeaders.OVERRIDE_FULL_URL);
        if (override === undefined || override === '') {
            throw new MissingRuntimeBaseUrlError(
                `${request.contractName}.${request.route.methodName} runs behind a ContextFullUrlFilter, so ` +
                    `its complete destination url must be supplied per call, but no ` +
                    `WebpiecesCoreHeaders.OVERRIDE_FULL_URL was found in the RequestContext. Set it around ` +
                    `the call:\n` +
                    `    RequestContext.putUntrusted(WebpiecesCoreHeaders.OVERRIDE_FULL_URL, webhook.url);\n` +
                    `Refusing rather than falling back to this client's configured service URL is ` +
                    `deliberate: a silent fallback would send a partner's payload to one of our own services.`,
                `${request.contractName}.${request.route.methodName}`,
            );
        }
        request.pointAtFullUrl(override);
        return nextFilter.invoke(request);
    }
}
