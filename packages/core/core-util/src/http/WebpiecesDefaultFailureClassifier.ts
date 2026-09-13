import {
    ApiBadRequestError,
    ApiUnauthorizedError,
    ApiForbiddenError,
    ApiNotFoundError,
    ApiEndUserError,
} from '../errors/ApiError';
import { ApiMethodInfo } from './ApiMethodInfo';
import { FailureClassifier } from './FailureClassifier';

/**
 * The webpieces built-in {@link FailureClassifier} — the terminal tier, used when no app default and
 * no per-apiClass classifier claims an error. It is the SINGLE SOURCE OF TRUTH for the historical
 * `LogApiCall.isUserError` behavior (which now delegates here), so the classification lives in one
 * place.
 *
 * The question is "are things WORKING?", NOT "was it an HTTP 4xx vs 5xx" — the two differ (see 408).
 * Classification is by portable Error TYPE, never by transport: this runs over in-process calls,
 * pubsub/queue handlers, and HTTP through one code path and only ever sees a thrown Error. The API
 * classes are portable error types that travel with the throw anywhere, so matching the TYPE works
 * with or without any HTTP in the picture.
 *
 * SERVER — a healthy server correctly rejecting a CLIENT'S mistake is metrics NOISE, not a failure:
 * - ApiBadRequestError (400), ApiUnauthorizedError (401), ApiForbiddenError (403),
 *   ApiNotFoundError (404) → the server is fine, the caller erred → NON-failure.
 * SERVER — something may actually be WRONG, so SURFACE it (failure):
 * - ApiRequestTimeoutError (408): a 4xx, but the client may NEVER have seen the response — deliberately
 *   absent below, so it counts as a failure. Implementation/dependency failures and non-API errors are failures.
 *
 * ApiEndUserError (266): ALWAYS a non-failure, server OR client — an expected "user made a mistake".
 * CLIENT: receiving ANY error except 266 means the outbound call FAILED → failure.
 */
export class WebpiecesDefaultFailureClassifier implements FailureClassifier {
    /**
     * Terminal tier — NEVER returns undefined (a definitive verdict is required so classification
     * always resolves to a boolean).
     *
     * @returns true = failure, false = expected/non-failure
     */
    isFailure(error: Error, methodInfo: ApiMethodInfo): boolean {
        // 266 is the one error that is never a failure, on either side.
        if (error instanceof ApiEndUserError) {
            return false;
        }
        // A client that RECEIVED any error (except the 266 above) made a failed call.
        if (methodInfo.side !== 'server') {
            return true;
        }
        // SERVER: only a healthy rejection of the caller's mistake is a non-failure. Note 408
        // (ApiRequestTimeoutError) is intentionally NOT here — the client may never have seen the response.
        const healthyRejection =
            error instanceof ApiBadRequestError ||
            error instanceof ApiUnauthorizedError ||
            error instanceof ApiForbiddenError ||
            error instanceof ApiNotFoundError;
        return !healthyRejection;
    }
}

/** Process-wide built-in instance — stateless, so one shared instance is enough. */
export const WEBPIECES_DEFAULT_FAILURE_CLASSIFIER = new WebpiecesDefaultFailureClassifier();
