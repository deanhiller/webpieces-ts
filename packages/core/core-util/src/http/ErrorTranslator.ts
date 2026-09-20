import { HttpResponseDto } from './HttpResponseDto';

/**
 * ErrorTranslator - ONE symmetric place an app owns HTTP error translation, in BOTH directions, over
 * the WHOLE response.
 *
 * An app implements this ONCE and registers it ONCE per process via
 * {@link ClientRegistry.setErrorTranslator} — on the server AND in the browser. Its `toWire` runs on
 * the SERVER (`ExpressWrapper.handleError`) and its `fromWire` runs on every CLIENT in that process
 * (`ClientErrorTranslator.throwIfFailure`, shared by `http-client-node` and `http-client-browser`).
 * The payoff is type symmetry across the wire: the server throws `OrderNotFoundError` and the caller
 * CATCHES `OrderNotFoundError`, instead of decoding a status code by hand at every call site.
 *
 * # THERE IS ALWAYS A TRANSLATOR
 *
 * {@link ClientRegistry.getErrorTranslator} is non-optional and starts life holding
 * {@link WebpiecesDefaultErrorTranslator}. So no caller anywhere asks "did anyone register one" —
 * every call site is ONE unconditional line. A registered app translator REPLACES the default and
 * declines by DELEGATING to it:
 *
 * ```ts
 * private readonly fallback = new WebpiecesDefaultErrorTranslator();
 * ```
 *
 * That is one call, it is visible at the call site, and it composes: an app that wants to DECORATE
 * the default rather than replace it does so by calling it and editing the result. A `next` parameter
 * was considered and rejected — it buys nothing this does not, and it puts the framework back in the
 * business of sequencing somebody else's precedence.
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
 * # `toWire` RETURNS a response; `fromWire` THROWS
 *
 * They are mirrors, not twins. `toWire` is called inside a catch and its whole job is to produce a
 * value, so it returns one. `fromWire` is called on a response the caller is about to be handed, and
 * its whole job is to stop that from happening, so it THROWS and is typed `void`. Returning an
 * `Error` the caller then has to remember to throw was the previous shape and it is exactly the bug
 * class this deletes: a `void` return cannot be silently dropped.
 *
 * There is exactly ONE registered ErrorTranslator per process (a `set`, not an `add` to a list):
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
 * export class OrderErrorTranslator implements ErrorTranslator {
 *     private readonly fallback = new WebpiecesDefaultErrorTranslator();
 *
 *     toWire(error: Error): HttpResponseDto {
 *         if (!(error instanceof OrderNotFoundError)) {
 *             return this.fallback.toWire(error);        // not mine -> webpieces default
 *         }
 *         const body = new OrderErrorPayload(error.message, 'ORDER_NOT_FOUND');
 *         return new HttpResponseDto(
 *             new HttpResponseStatus(460, 'Order Not Found'),
 *             [new HttpHeader('x-order-trace', error.traceId)],
 *             body,
 *         );
 *     }
 *
 *     fromWire(response: HttpResponseDto): void {
 *         if (response.status.code !== 460) {
 *             this.fallback.fromWire(response);          // not mine -> webpieces default
 *             return;
 *         }
 *         throw new OrderNotFoundError(String(response.body));
 *     }
 * }
 *
 * // startup, ONCE per process (server AND browser)
 * ClientRegistry.setErrorTranslator(new OrderErrorTranslator());
 * ```
 */
export interface ErrorTranslator {
    /**
     * SERVER: exception -> the ENTIRE response (status code, reason phrase, headers, body). Always a
     * response, never `undefined`; decline by returning
     * `new WebpiecesDefaultErrorTranslator().toWire(error)`.
     */
    toWire(error: Error): HttpResponseDto;

    /**
     * CLIENT: the ENTIRE response -> a THROW. Receives the SAME shape `toWire` produces, normalised
     * from whichever transport read it.
     *
     * Called for EVERY response, including a 2xx — deliberately, so an app whose 200 body signals
     * failure can turn it into a throw. Returning normally means "let this response through"; the
     * webpieces default returns normally for any 2xx that is not 266 and throws otherwise. Decline by
     * calling `new WebpiecesDefaultErrorTranslator().fromWire(response)`.
     *
     * A non-2xx response can never reach a typed caller even if an app translator forgets to throw:
     * `ClientErrorTranslator.throwIfFailure` applies the webpieces default behind it. That is bug
     * containment, not a "was one registered" branch.
     */
    fromWire(response: HttpResponseDto): void;
}
