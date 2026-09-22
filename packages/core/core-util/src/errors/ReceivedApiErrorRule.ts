import {
    ApiBadGatewayError,
    ApiDependencyBackoffError,
    ApiDependencyError,
    ApiDependencyTimeoutError,
    ApiEndUserError,
    ApiError,
    ApiImplementationError,
    ApiUnavailableError,
} from './ApiError';

/**
 * THE rule for an error this process RECEIVED from another one — identical over HTTP and over IPC,
 * which is why it lives here and not in either protocol's translator.
 *
 * A status a peer answered describes OUR request to it. It is never, by itself, an answer for our
 * own caller, and the two ways it can be wrong have OPPOSITE owners:
 *
 * - **ordinary caller-error status (4xx-equivalent) -> {@link ApiImplementationError}.** WE sent a bad request,
 *   called a path that does not exist, or presented the wrong credentials. MY bug. The peer that
 *   answered 404 is correct.
 * - **ordinary server-error status (5xx-equivalent) -> {@link ApiDependencyError}.** THEY broke. Not my bug,
 *   so this process's failure metrics stay clean and page the right team.
 * - **an {@link ApiDependencyError} coming back -> rethrown AS-IS.** The fault is already attributed,
 *   somewhere further downstream; this hop adds nothing by re-wrapping it, and re-wrapping would bury
 *   the original message one `cause` deeper on every hop of a chain.
 * - **408/429/502/503/504 preserve retry-relevant semantics.** Timeout, backoff, bad-gateway and
 *   unavailable must not collapse into the generic non-retryable dependency bucket.
 * - **266 / `end-user` -> {@link ApiEndUserError}**, the intended user-facing message, published
 *   verbatim. It is the one message the taxonomy lets a peer write for a human.
 *
 * # Why this is UNIFORM, in a browser as much as in a server
 *
 * An earlier design made the browser pass a received status through unchanged on the theory that
 * "the browser IS the user's agent, so a 404 is the user's answer". That is wrong. If a browser
 * received a 404 the browser called the wrong path — that is the BROWSER's bug, and the code that
 * catches it wants to know that, not to show a user a spinner. Read in a browser this reads exactly
 * as intended: `ApiImplementationError` means the client has a bug, `ApiDependencyError` means the
 * server has one.
 *
 * An app that genuinely wants a peer's status relayed as its OWN typed error says so out loud, in one
 * greppable place, by throwing it from its registered translator's `fromWire`.
 */
export class ReceivedApiErrorRule {
    /**
     * @param statusCode - the HTTP status the peer published. IPC has no wire status, so it derives
     *   the equivalent from the payload's `kind` through the same `ApiErrorHttpStatus` table — one
     *   table, so the two protocols cannot drift apart.
     * @param message - the text to carry forward: the decoded payload's message, else whatever the
     *   transport could salvage from the body.
     * @param decoded - the peer's own typed error when the body was a webpieces `ApiErrorPayload`.
     *   Absent for a foreign responder.
     */
    // webpieces-disable no-function-outside-class -- stateless shared rule, called by both protocol translators
    static adapt(
        statusCode: number,
        message: string,
        decoded?: ApiError,
        retryAfterSeconds?: number,
    ): Error {
        // 266 is protocol SUCCESS carrying the actor's own answer — the one message published verbatim.
        if (statusCode === 266) {
            return decoded instanceof ApiEndUserError ? decoded : new ApiEndUserError(message);
        }
        if (
            decoded instanceof ApiDependencyError ||
            decoded instanceof ApiBadGatewayError ||
            decoded instanceof ApiUnavailableError ||
            decoded instanceof ApiDependencyTimeoutError ||
            decoded instanceof ApiDependencyBackoffError
        ) {
            return decoded;
        }
        if (statusCode === 408 || statusCode === 504) {
            return new ApiDependencyTimeoutError(
                `dependency timed out with HTTP ${statusCode}. Downstream said: ${message}`,
                decoded,
            );
        }
        if (statusCode === 429 || (statusCode === 503 && retryAfterSeconds !== undefined)) {
            return new ApiDependencyBackoffError(
                `dependency asked this service to back off after HTTP ${statusCode}. ` +
                    `Downstream said: ${message}`,
                retryAfterSeconds,
                decoded,
            );
        }
        if (statusCode === 502) {
            return new ApiBadGatewayError(
                `gateway answered HTTP 502. Downstream said: ${message}`,
                decoded,
            );
        }
        if (statusCode === 503) {
            return new ApiUnavailableError(
                `dependency is unavailable (HTTP 503). Downstream said: ${message}`,
                decoded,
            );
        }
        if (statusCode >= 500) {
            return new ApiDependencyError(
                `dependency answered ${statusCode} — it is broken, not this service. ` +
                    `Downstream said: ${message}`,
                decoded,
            );
        }
        return new ApiImplementationError(
            `dependency answered ${statusCode}. That status describes OUR request to it, not an ` +
                `answer for our caller, so this service owns it — check the path, the base URL, ` +
                `whether the dependency is deployed, and our service credentials. ` +
                `Downstream said: ${message}`,
            decoded,
        );
    }
}
