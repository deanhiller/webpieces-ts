import { NextFunction, Request, Response } from 'express';
import { LogManager, OAuthErrorResponse, OAuthProtocolError } from '@webpieces/core-util';
import { ExpressResponseWriter } from './ExpressResponseWriter';

const log = LogManager.getLogger('OAuthExpressErrorHandler');

/**
 * The express boundary for an app's OWN OAuth routes — `/oauth/token`, `/oauth/register`,
 * `/oauth/authorize` — which an app mounts directly on express beside `WpMcpServer.bind(...)`
 * (webpieces leaves token issuance pluggable). It answers an {@link OAuthProtocolError} in the RFC
 * 6749/6750 shape and logs it at INFO as an EXPECTED refusal (#1176); anything else is passed to
 * the next express error handler untouched, so a real bug is still a fault.
 *
 * Two ways to use it, for the two shapes a raw route boundary takes:
 *
 * ```ts
 * const oauthErrors = new OAuthExpressErrorHandler();
 * // 1. as express error middleware (express 5 forwards an async handler's rejection to it)
 * app.post('/oauth/token', urlencoded({ extended: false }), tokenHandler, oauthErrors.middleware);
 * // 2. from a route's own try/catch
 * if (err instanceof OAuthProtocolError) oauthErrors.write(res, err);
 * ```
 *
 * A webpieces `@Endpoint` that throws an `OAuthProtocolError` needs neither: the default
 * `ErrorTranslator` renders it with the same `OAuthErrorResponse`.
 */
export class OAuthExpressErrorHandler {
    private readonly responseWriter = new ExpressResponseWriter();

    /**
     * Express error middleware (four parameters, which is how express recognises one). An arrow
     * property so it can be handed to `app.use(...)` without losing `this`.
     */
    // webpieces-disable no-any-unknown -- express hands an error handler whatever was thrown
    readonly middleware = (
        failure: unknown,
        _req: Request,
        res: Response,
        next: NextFunction,
    ): void => {
        if (!(failure instanceof OAuthProtocolError)) {
            next(failure);
            return;
        }
        this.write(res, failure);
    };

    /** Write `error` in the RFC shape, with its status and headers, and log it at INFO. */
    write(res: Response, error: OAuthProtocolError): void {
        const level = error.isCallerError() ? 'refused' : 'unavailable';
        log.info(
            `OAuth request ${level}: status=${error.status} error=${error.error} message=${error.message}`,
        );
        if (res.headersSent) {
            res.end();
            return;
        }
        this.responseWriter.write(res, OAuthErrorResponse.toResponse(error, undefined));
    }
}
