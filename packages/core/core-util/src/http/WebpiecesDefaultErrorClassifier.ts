import {
    ApiBadRequestError,
    ApiUnauthorizedError,
    ApiForbiddenError,
    ApiNotFoundError,
    ApiEndUserError,
    ApiConflictError,
    ApiUnprocessableError,
    ApiPreconditionFailedError,
    ApiUnsupportedMediaTypeError,
    ApiCodedError,
    ApiRetriesExhaustedError,
    ApiRequestTimeoutError,
    ApiDependencyTimeoutError,
    ApiBadGatewayError,
    ApiUnavailableError,
    ApiRateLimitedError,
    ApiDependencyBackoffError,
    ApiConnectionError,
} from '../errors/ApiError';
import { OAuthProtocolError } from '../oauth/OAuthProtocolError';
import { ApiMethodInfo } from './ApiMethodInfo';
import { CallOutcome, ErrorClassifier } from './ErrorClassifier';

/**
 * The webpieces built-in {@link ErrorClassifier} — the terminal tier, used when no per-apiClass
 * classifier and no app default claims an error. Two tables, one per question:
 *
 * # 1. EXPECTED or not — "are things WORKING?"
 *
 * NOT "was it an HTTP 4xx vs 5xx" — the two differ (see 408). Classification is by portable Error
 * TYPE, never by transport: this runs over in-process calls, queue handlers and HTTP through one code
 * path and only ever sees a thrown Error.
 *
 * - ApiEndUserError (266): ALWAYS expected, server OR client — an expected "user made a mistake".
 * - SERVER — a healthy server correctly rejecting a CLIENT'S mistake is metrics NOISE, not a failure:
 *   ApiBadRequestError (400), ApiUnauthorizedError (401), ApiForbiddenError (403), ApiNotFoundError
 *   (404), ApiConflictError (409), ApiPreconditionFailedError (412), ApiUnsupportedMediaTypeError
 *   (415), ApiUnprocessableError (422), an ApiCodedError whose `isCallerError()` is true (below 500,
 *   except 408/429), and an OAuthProtocolError below 500 (a refused grant is the OAuth protocol
 *   working, #1176). ApiRequestTimeoutError (408) is deliberately absent: the client may NEVER have
 *   seen the response.
 * - CLIENT: receiving ANY error except 266 means the outbound call failed — never expected here.
 *   (An external client whose 404 means "miss" registers its own classifier for that.)
 *
 * # 2. TRANSIENT or FAILURE — "may repeating it work?"
 *
 * The kind table that used to live inside the MCP renderer:
 *
 * - TRANSIENT: request-timeout (408), dependency-timeout (504, incl. a client's own
 *   `ApiCallTimeoutError`), bad-gateway (502 proxy), unavailable (503), rate-limited (429),
 *   dependency-backoff, connection, and an ApiCodedError of 408/429.
 * - FAILURE: everything else — a received 4xx (our bug), implementation, not-implemented (501), a
 *   generic dependency defect, and {@link ApiRetriesExhaustedError}, which is checked FIRST: it is an
 *   `ApiDependencyError`, and classifying it transient would let every layer above retry again.
 */
export class WebpiecesDefaultErrorClassifier implements ErrorClassifier {
    /** Terminal tier — NEVER returns undefined. */
    classify(error: Error, methodInfo: ApiMethodInfo): CallOutcome {
        if (this.isExpected(error, methodInfo)) {
            return CallOutcome.EXPECTED;
        }
        return this.isTransient(error) ? CallOutcome.TRANSIENT_FAILURE : CallOutcome.FAILURE;
    }

    private isExpected(error: Error, methodInfo: ApiMethodInfo): boolean {
        // 266 is the one error that is never a failure, on either side.
        if (error instanceof ApiEndUserError) {
            return true;
        }
        // A client that RECEIVED any other error made a failed call.
        if (methodInfo.side !== 'server') {
            return false;
        }
        return (
            error instanceof ApiBadRequestError ||
            error instanceof ApiUnauthorizedError ||
            error instanceof ApiForbiddenError ||
            error instanceof ApiNotFoundError ||
            error instanceof ApiConflictError ||
            error instanceof ApiUnprocessableError ||
            error instanceof ApiPreconditionFailedError ||
            error instanceof ApiUnsupportedMediaTypeError ||
            (error instanceof ApiCodedError && error.isCallerError()) ||
            (error instanceof OAuthProtocolError && error.isCallerError())
        );
    }

    private isTransient(error: Error): boolean {
        // FIRST: a lower layer already retried. Never transient, or every layer above retries too.
        if (error instanceof ApiRetriesExhaustedError) {
            return false;
        }
        if (error instanceof ApiCodedError) {
            return error.statusCode === 408 || error.statusCode === 429;
        }
        return (
            error instanceof ApiRequestTimeoutError ||
            error instanceof ApiDependencyTimeoutError ||
            error instanceof ApiBadGatewayError ||
            error instanceof ApiUnavailableError ||
            error instanceof ApiRateLimitedError ||
            error instanceof ApiDependencyBackoffError ||
            error instanceof ApiConnectionError
        );
    }
}

/** Process-wide built-in instance — stateless, so one shared instance is enough. */
export const WEBPIECES_DEFAULT_ERROR_CLASSIFIER = new WebpiecesDefaultErrorClassifier();
