import { HttpResponseDto } from './HttpResponseDto';

/**
 * ErrorTranslators - ONE symmetric place an app owns error translation, in BOTH directions, over the
 * WHOLE response.
 *
 * An app implements this ONCE and registers it ONCE per process via
 * {@link ClientRegistry.setErrorTranslators} — on the server AND in the browser. Its `toWire` runs on
 * the SERVER (`ExpressWrapper.handleError`) and its `fromWire` runs on every CLIENT in that process
 * (`ClientErrorTranslator.translateError`, shared by `http-client-node` and `http-client-browser`).
 * The payoff is type symmetry across the wire: the server throws `OrderNotFoundError` and the caller
 * CATCHES `OrderNotFoundError`, instead of decoding a status code by hand at every call site.
 *
 * # Both halves speak {@link HttpResponseDto}, and that is the point
 *
 * `toWire` PRODUCES exactly what `fromWire` CONSUMES. Reading the two methods against each other in
 * one file is what makes a mistake visible, which is why this is one object rather than two
 * separately-registered functions.
 *
 * # The whole response, not a status plus a body
 *
 * The previous contract could express only `(statusCode, protocolError)`, so an app could not put its
 * own trace id, `Retry-After`, `WWW-Authenticate` or a cookie on an error response. A translator now
 * returns the status code, the reason phrase, the header LIST and the body — everything.
 *
 * # `toWire` REPLACES the default; it declines by DELEGATING to it
 *
 * `toWire` never returns `undefined`. An error in, the exact wire shape out — the same contract every
 * other outbound boundary in the framework has. A registered translator is THE server-side
 * translator for this process, so "not mine" is spelled by calling the webpieces default, which is a
 * public class it already has: `new ApiErrorHttpMapper('gui').toResponse(error)`
 * (`@webpieces/http-server`) — pass `'edge'` instead when this router was configured with
 * `setEndUserStatus('edge')`, so a delegated end-user error keeps that router's published status.
 *
 * That is one call, it is visible at the call site, and it composes: an app that wants to DECORATE
 * the default rather than replace it does so by calling it and editing the result. A `next` parameter
 * was considered and rejected — it buys nothing this does not, and it puts the framework back in the
 * business of sequencing somebody else's precedence.
 *
 * # `fromWire` KEEPS `undefined`, and it is not the same question
 *
 * On the CLIENT half, `undefined` is not "fall back" — it is PROVENANCE. `TranslatedFailure`
 * carries `appRegistered`, and `NodeProxyClient.adaptDownstreamFailure` reads it to decide whether a
 * downstream 4xx is relayed as the app's own typed error or wrapped as this service's 500. An
 * `ApiNotFoundError` the built-in 404 branch produced and one an app CLAIMED are identical as
 * values and mean opposite things, so the claim has to be expressible. Returning
 * `ClientErrorTranslator.builtInError(response)` instead would silently assert the app claimed every
 * status it has an opinion about, and the server-to-server 4xx-to-500 invariant would stop firing.
 *
 * There is exactly ONE registered ErrorTranslators per process (a `set`, not an `add` to a list):
 * precedence between an app's own layers is the APP's to compose explicitly inside its `toWire`,
 * rather than something hidden in registration order inside the framework.
 *
 * # Not covered: 404 / unknown route
 *
 * A request that matches no route has no route context and never reaches this seam. That is
 * deliberate and out of scope.
 *
 * This is a business-logic contract (methods, not data), so it is an interface per the webpieces
 * guidelines.
 *
 * ```ts
 * class OrderErrorPayload {
 *     constructor(public message: string, public errorCode: string) {}
 * }
 *
 * export class OrderErrorTranslators implements ErrorTranslators {
 *     private readonly fallback = new ApiErrorHttpMapper('gui');
 *
 *     toWire(error: Error): HttpResponseDto {
 *         if (!(error instanceof OrderNotFoundError)) {
 *             return this.fallback.toResponse(error);    // not mine -> webpieces default
 *         }
 *         const body = new OrderErrorPayload(error.message, 'ORDER_NOT_FOUND');
 *         return new HttpResponseDto(
 *             new HttpResponseStatus(460, 'Order Not Found'),
 *             [new HttpHeader('x-order-trace', error.traceId)],
 *             body,
 *         );
 *     }
 *
 *     fromWire(response: HttpResponseDto): Error | undefined {
 *         if (response.status.code !== 460) {
 *             return undefined;              // not claimed -> webpieces' built-in mapping
 *         }
 *         return new OrderNotFoundError(String(response.body));
 *     }
 * }
 *
 * // startup, ONCE per process (server AND browser)
 * ClientRegistry.setErrorTranslators(new OrderErrorTranslators());
 * ```
 */
export interface ErrorTranslators {
    /**
     * SERVER: exception -> the ENTIRE response (status code, reason phrase, headers, body). Always a
     * response; decline by returning the webpieces default's own (`ApiErrorHttpMapper.toResponse`).
     */
    toWire(error: Error): HttpResponseDto;

    /**
     * CLIENT: the ENTIRE response -> a typed exception. Receives the SAME shape `toWire` produces,
     * normalised from whichever transport read it. `undefined` => this app does not CLAIM this
     * status; webpieces' built-in status-to-type mapping answers instead, and the failure is marked
     * as not app-registered (see the class doc — that flag is what an environment hook acts on).
     */
    fromWire(response: HttpResponseDto): Error | undefined;
}
