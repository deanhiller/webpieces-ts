import {
    ApiImplementationError,
    ClientRole,
    HttpResponseDto,
    RouteMetadata,
    WEBPIECES_DEFAULT_ERROR_TRANSLATOR,
    ApiRegistry,
} from '@webpieces/core-util';

/**
 * The CLIENT half of the wire seam: hand every response to the {@link ErrorTranslator} registered
 * for the called ROUTE — its contract class and method, resolved on the `CallScope` ladder (method ->
 * API -> ALL -> webpieces default) — and guarantee the one invariant a typed caller depends on. That
 * ladder is what lets one vendor contract read its OWN error body while every other contract in the
 * process keeps the app's ALL translator.
 *
 * There is no "was a translator registered" question here — {@link ApiRegistry.getErrorTranslator}
 * never returns undefined — and no `TranslatedFailure` provenance record either. Provenance existed only to
 * feed `ProxyClient.adaptDownstreamFailure`, and the uniform 4xx/5xx rule in
 * {@link WebpiecesDefaultErrorTranslator} deleted that hook: an app that wants a downstream status
 * relayed as its own type says so by THROWING it from its own `fromWire`.
 */
export class ClientErrorTranslator {
    /**
     * Run `fromWire` over a response, and make it impossible for a FAILURE response to be handed to a
     * typed caller as if it were data.
     *
     * Every response goes through here, 2xx included, so an app whose 200 body signals failure can
     * turn it into a throw (see {@link ErrorTranslator.fromWire}).
     *
     * The second call is BUG CONTAINMENT, not a fallback branch: an app translator that returns
     * normally for a non-2xx has a bug whose symptom would otherwise be `undefined` arriving where
     * the contract promised a DTO. The webpieces default answers instead — and for a genuine 2xx it
     * returns silently, so the normal path costs one predicate.
     *
     * @param role - who is receiving, from the calling client's `ClientConfig` (see {@link ClientRole}).
     * @param route - the called route; its contract class and method select the translator.
     */
    // webpieces-disable no-function-outside-class -- pure stateless mapping shared by browser and node
    static throwIfFailure(response: HttpResponseDto, role: ClientRole, route: RouteMetadata): void {
        ApiRegistry.getErrorTranslator(route.apiClass, route.methodName).fromWire(response, role);
        WEBPIECES_DEFAULT_ERROR_TRANSLATOR.fromWire(response, role);
    }

    /**
     * {@link throwIfFailure} for a response the CALLER has already established is not an ordinary
     * success (not 2xx, or a 266). Typed `never`, which is what lets `ProxyClient.readResponse` end on
     * this call instead of on a `return undefined` the contract forbids.
     *
     * The trailing throw is NOT dead code standing in for a type: it fires exactly when this is
     * called with an ordinary 2xx, which is a framework bug in the caller, and says so.
     */
    // webpieces-disable no-function-outside-class -- pure stateless mapping shared by browser and node
    static throwFailure(response: HttpResponseDto, role: ClientRole, route: RouteMetadata): never {
        ClientErrorTranslator.throwIfFailure(response, role, route);
        throw new ApiImplementationError(
            `ClientErrorTranslator.throwFailure was called for HTTP ${response.status.code}, ` +
                `which is an ordinary success. Only a non-2xx (or a 266) response reaches here; ` +
                `use throwIfFailure for a response that may legitimately pass.`,
        );
    }
}
