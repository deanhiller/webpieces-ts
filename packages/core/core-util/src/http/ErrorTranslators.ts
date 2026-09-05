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
 * # `undefined` means "not mine"
 *
 * Either method returns `undefined` to step aside and let the webpieces default answer. There is
 * exactly ONE registered ErrorTranslators per process (a `set`, not an `add` to a list): precedence
 * between an app's own layers is the APP's to compose explicitly inside its `toWire`, rather than
 * something hidden in registration order inside the framework.
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
 * export class OrderErrorTranslators implements ErrorTranslators {
 *     toWire(error: Error): HttpResponseDto | undefined {
 *         if (!(error instanceof OrderNotFoundError)) {
 *             return undefined;              // not mine -> webpieces default
 *         }
 *         const body = new ProtocolError();
 *         body.message = error.message;
 *         body.errorCode = 'ORDER_NOT_FOUND';
 *         return new HttpResponseDto(
 *             new HttpResponseStatus(460, 'Order Not Found'),
 *             [new HttpHeader('x-order-trace', error.traceId)],
 *             body,
 *         );
 *     }
 *
 *     fromWire(response: HttpResponseDto): Error | undefined {
 *         if (response.status.code !== 460) {
 *             return undefined;              // not mine -> webpieces default
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
     * SERVER: exception -> the ENTIRE response (status code, reason phrase, headers, body).
     * `undefined` => this translator does not claim `error`; webpieces' default answers instead.
     */
    toWire(error: Error): HttpResponseDto | undefined;

    /**
     * CLIENT: the ENTIRE response -> a typed exception. Receives the SAME shape `toWire` produces,
     * normalised from whichever transport read it. `undefined` => not claimed; webpieces' built-in
     * status-to-type mapping answers instead.
     */
    fromWire(response: HttpResponseDto): Error | undefined;
}
