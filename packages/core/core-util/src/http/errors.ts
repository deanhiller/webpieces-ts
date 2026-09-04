/**
 * HTTP Error classes for webpieces-ts.
 * These errors are used throughout the framework for consistent error handling.
 */

/**
 * ProtocolError - Data class for error response body.
 * This is what gets serialized and sent to the client.
 *
 * EVERY field here is caller-facing, so the framework fills it CONSERVATIVELY. `HttpErrorWireMapper`
 * (http-server) copies `message` from the thrown error for {@link HttpUserError} ONLY — the one type
 * whose message is written for a human to read — and sends the generic HTTP reason phrase for every
 * other type, because `Error.message` is an operator-facing field that routinely quotes downstream
 * urls, response bodies and internal ids. `name` is not filled by that ladder at all.
 *
 * An app that wants to publish more than that does it deliberately, by registering an
 * {@link ErrorTranslators} with {@link ClientRegistry}, whose `toWire()` result is sent verbatim.
 */
export class ProtocolError {
    public message?: string;
    public subType?: string;
    public field?: string;
    public waitSeconds?: number;
    /**
     * Filled only by an app's own `ErrorTranslators.toWire()`. The built-in HttpError ladder does NOT
     * send it: nothing on the client reads it, and for a subclass it is an internal class name.
     */
    public name?: string;
    public guiAlertMessage?: string;
    public errorCode?: string;
}

/**
 * HttpError - Base error class with HTTP status code.
 * All specific HTTP errors extend this class.
 */
export class HttpError extends Error {
    public code: number;
    public subType?: string;
    public readonly httpCause?: Error;

    constructor(message: string, code: number, subType?: string, cause?: Error) {
        super(message);
        this.code = code;
        this.subType = subType;
        this.httpCause = cause;
    }
}

// Error subtype constants
export const ENTITY_NOT_FOUND = 'EntityNotFoundError';
export const WRONG_LOGIN_TYPE = 'wrongLoginType';
export const WRONG_LOGIN = 'wronglogin';
export const NOT_APPROVED = 'notapproved';
export const EMAIL_NOT_CONFIRMED = 'email_not_confirmed';
export const WRONG_DOMAIN = 'wrongdomain';
export const WRONG_COMPANY = 'wrongcompany';
export const NO_REG_CODE = 'noregcode';

/**
 * HttpNotFoundError - 404 Not Found.
 */
export class HttpNotFoundError extends HttpError {
    constructor(message: string, cause?: Error) {
        super(message, 404, undefined, cause);
        this.name = ENTITY_NOT_FOUND;
        Object.setPrototypeOf(this, new.target.prototype);
    }
}

/**
 * EndpointNotFoundError - 404 for missing endpoints.
 */
export class EndpointNotFoundError extends HttpNotFoundError {
    constructor(message: string, cause?: Error) {
        super(message, cause);
        this.name = 'EndpointNotFoundError';
        Object.setPrototypeOf(this, new.target.prototype);
    }
}

/**
 * HttpBadRequestError - 400 Bad Request.
 * Used for validation errors with optional field and GUI message.
 */
export class HttpBadRequestError extends HttpError {
    public field?: string;
    public guiMessage?: string;

    constructor(message: string, field?: string, guiMessage?: string, cause?: Error) {
        super(message, 400, undefined, cause);
        this.name = 'BadRequest';
        this.field = field;
        this.guiMessage = guiMessage;
        Object.setPrototypeOf(this, new.target.prototype);
    }
}

/**
 * HttpUnauthorizedError - 401 Unauthorized.
 */
export class HttpUnauthorizedError extends HttpError {
    constructor(message: string, subType?: string, cause?: Error) {
        super(message, 401, subType, cause);
        this.name = 'Unauthorized';
        Object.setPrototypeOf(this, new.target.prototype);
    }
}

/**
 * HttpTooManyRequestsError - 429 Too Many Requests.
 *
 * The one member of the HttpError ladder that never made it over from the production service this ladder was ported from. Without it, apps are
 * forced back to `err.code === 429` — the exact untyped pattern this ladder exists to replace.
 */
export class HttpTooManyRequestsError extends HttpError {
    constructor(message: string, cause?: Error) {
        super(message, 429, undefined, cause);
        this.name = 'TooManyRequests';
        Object.setPrototypeOf(this, new.target.prototype);
    }
}

/**
 * HttpForbiddenError - 403 Forbidden.
 */
export class HttpForbiddenError extends HttpError {
    constructor(message: string, cause?: Error) {
        super(message, 403, undefined, cause);
        this.name = 'Forbidden';
        Object.setPrototypeOf(this, new.target.prototype);
    }
}

/**
 * HttpTimeoutError - 408 Request Timeout.
 */
export class HttpTimeoutError extends HttpError {
    constructor(message: string, cause?: Error) {
        super(message, 408, undefined, cause);
        this.name = 'Timeout';
        Object.setPrototypeOf(this, new.target.prototype);
    }
}

/**
 * HttpBadGatewayError - 502 Bad Gateway.
 */
export class HttpBadGatewayError extends HttpError {
    constructor(message: string, cause?: Error) {
        super(message, 502, undefined, cause);
        this.name = 'HttpBadGatewayError';
        Object.setPrototypeOf(this, new.target.prototype);
    }
}

/**
 * HttpServiceUnavailableError - 503 Service Unavailable.
 *
 * The cold-start code: a scale-to-zero backend (Cloud Run `min_instance_count = 0`) whose instance
 * is still booting is answered by the load balancer with a 503 and ITS OWN HTML page — no
 * ProtocolError body at all. Without this member the client fell through to a generic `HttpError`,
 * so an app could not say "the server is waking, retry" without matching on `err.code === 503`,
 * which is the untyped pattern this ladder exists to replace.
 */
export class HttpServiceUnavailableError extends HttpError {
    constructor(message: string, cause?: Error) {
        super(message, 503, undefined, cause);
        this.name = 'HttpServiceUnavailableError';
        Object.setPrototypeOf(this, new.target.prototype);
    }
}

/**
 * HttpGatewayTimeoutError - 504 Gateway Timeout.
 * SHOULD NOT BE USED SERVER SIDE SINCE ALBs will return 504 and it will not be translated
 * to json body 'ProtocolError'.
 */
export class HttpGatewayTimeoutError extends HttpError {
    constructor(message: string, cause?: Error) {
        super(message, 504, undefined, cause);
        this.name = 'HttpGatewayTimeoutError';
        Object.setPrototypeOf(this, new.target.prototype);
    }
}

/**
 * HttpInternalServerError - 500 Internal Server Error.
 */
export class HttpInternalServerError extends HttpError {
    constructor(message: string, cause?: Error) {
        super(message, 500, undefined, cause);
        this.name = 'InternalServerError';
        Object.setPrototypeOf(this, new.target.prototype);
    }
}

/**
 * HttpVendorError - 598 Vendor Error.
 * Custom status code for vendor/external service errors with retry hint.
 */
export class HttpVendorError extends HttpError {
    constructor(
        message: string,
        public waitSeconds = 30,
        cause?: Error,
    ) {
        super(message, 598, undefined, cause);
        this.name = 'VendorError';
        Object.setPrototypeOf(this, new.target.prototype);
    }
}

/**
 * HttpUserError - User validation error with 2xx status code.
 *
 * Uses HTTP 266 (non-standard 2xx code) intentionally because:
 * 1. User validation errors are "successful" from server perspective - user just made a mistake
 * 2. Browser DevTools show 4xx/5xx codes in RED, which is confusing for user validation
 * 3. Allows error to propagate up the stack via throw without triggering error monitoring
 * 4. Avoids polluting logs with "errors" that are actually expected user behavior
 *
 * This is a deliberate design pattern - do NOT change to 4xx codes.
 * Examples: "Email already exists", "Invalid password format", "Required field missing"
 *
 * # It is also the ONLY type whose `message` reaches the caller
 *
 * `HttpErrorWireMapper` (http-server) copies `message` onto the response body for this type and no
 * other; every other subclass sends the generic HTTP reason phrase for its status. That is not an
 * arbitrary exception — it follows from the four points above. This type MEANS "this text was written
 * for a human to read", where `Error.message` everywhere else means "this text was written for whoever
 * reads the logs" and routinely quotes downstream urls, response bodies and internal ids.
 *
 * So: text the user must SEE goes in an `HttpUserError` (or in `HttpBadRequestError.guiMessage`,
 * which is the same idea one field down). Throwing `new HttpForbiddenError('you need the admin role
 * on tenant 4471')` shows the user 'Forbidden' and nothing else.
 */
export class HttpUserError extends HttpError {
    public errorCode?: string;

    constructor(message: string, errorCode?: string, cause?: Error) {
        super(message, 266, 'USER_ERROR', cause);
        this.name = 'UserError';
        this.errorCode = errorCode;
        Object.setPrototypeOf(this, new.target.prototype);
    }
}

/**
 * OfflineError - the request never reached a server.
 *
 * Offline, DNS failure, connection refused, CORS preflight rejected: `fetch` itself rejected, so no
 * Response — and therefore no HTTP status — ever existed. That is precisely why this extends `Error`
 * and NOT `HttpError`: an `HttpError` carries a `code` and means "the server replied with a failure",
 * a different situation a caller usually retries differently. Subclassing it would give this a bogus
 * status and make it match `instanceof HttpError` ladders that must not catch a transport reject.
 *
 * The original failure (a raw `TypeError: Failed to fetch`, or undici's coded reject) is always
 * preserved as `cause`, so a caller that wants the underlying detail can still reach it.
 */
export class OfflineError extends Error {
    constructor(message: string, cause?: Error) {
        super(message, { cause });
        this.name = 'OfflineError';
        Object.setPrototypeOf(this, new.target.prototype);
    }
}
