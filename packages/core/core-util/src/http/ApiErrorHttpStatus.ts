import { ApiError, ApiErrorKind } from '../errors/ApiError';

/**
 * Every kind that HAS an HTTP status. `'connection'` is excluded on purpose: a caller-local
 * connection failure is never published as itself — `ApiErrorBoundary.encode` publishes it as
 * `implementation` — so asking this table for its status is a bug the COMPILER now rejects rather
 * than a `throw` at the bottom of a switch.
 */
export type PublishedKind = Exclude<ApiErrorKind, 'connection'>;

/** An {@link ApiError} that {@link ApiErrorHttpStatus.hasCode} has proved carries an HTTP status. */
export type PublishedApiError = ApiError & { readonly kind: PublishedKind };

/** HTTP-only adapter: semantic errors themselves have no protocol status property. */
export class ApiErrorHttpStatus {
    /**
     * CLIENT direction. A client that just DECODED a payload holds an `ApiError`, and needs to know
     * whether the status it received agrees with the kind the body claims. This narrows the error to
     * the kinds {@link codeFor} accepts, so the pair reads as one guarded call with no cast.
     */
    // webpieces-disable no-function-outside-class -- stateless mapping predicate
    static hasCode(error: ApiError): error is PublishedApiError {
        return error.kind !== 'connection';
    }

    /**
     * The ONE status table, keyed by the published kind. `statusCode` is the `'coded'` kind's own
     * status — it travels on {@link ApiErrorPayload.statusCode} and on `ApiCodedError.statusCode`,
     * so both directions can supply it without this table reaching back into the error object.
     */
    // webpieces-disable no-function-outside-class -- stateless mapping shared by HTTP adapters
    static codeFor(kind: PublishedKind, statusCode?: number): number {
        switch (kind) {
            case 'end-user':
                return 266;
            case 'bad-request':
                return 400;
            case 'unauthorized':
                return 401;
            case 'forbidden':
                return 403;
            case 'not-found':
            case 'endpoint-not-found':
                return 404;
            case 'request-timeout':
                return 408;
            case 'conflict':
                return 409;
            case 'precondition-failed':
                return 412;
            case 'unsupported-media-type':
                return 415;
            case 'unprocessable':
                return 422;
            case 'rate-limited':
                return 429;
            case 'implementation':
                return 500;
            case 'not-implemented':
                return 501;
            case 'coded':
                // A 'coded' failure whose status did not survive the wire is an internal failure to
                // this adapter, not a status it may invent.
                return statusCode ?? 500;
            case 'dependency':
                return 502;
            case 'unavailable':
            case 'dependency-backoff':
                return 503;
            case 'dependency-timeout':
                return 504;
        }
    }
}
