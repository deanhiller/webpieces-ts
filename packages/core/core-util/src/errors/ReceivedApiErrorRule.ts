import {
    ApiBadGatewayError,
    ApiClientTooOldError,
    ApiDependencyBackoffError,
    ApiDependencyError,
    ApiDependencyTimeoutError,
    ApiEndUserError,
    ApiError,
    ApiImplementationError,
    ApiUnauthorizedError,
    ApiUnavailableError,
} from './ApiError';
import { ClientRole } from './ClientRole';

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
 *   verbatim. It is the one message the taxonomy lets a peer write for a human. `ApiErrorCodec` has
 *   already rebuilt the registered SUBCLASS for its `errorCode` (see `EndUserErrorRegistry`).
 * - **426 / `client-too-old` -> {@link ApiClientTooOldError}, rethrown AS-IS, on EVERY hop and for
 *   every {@link ClientRole}.** It is not "I called wrong", it is "the build on the calling side is
 *   older than the server allows", and every receiver must see "upgrade", never a bug report.
 *
 * # Why this is UNIFORM, in a browser as much as in a server — with ONE exception, 401
 *
 * An earlier design made the browser pass a received status through unchanged on the theory that
 * "the browser IS the user's agent, so a 404 is the user's answer". That is wrong. If a browser
 * received a 404 the browser called the wrong path — that is the BROWSER's bug, and the code that
 * catches it wants to know that, not to show a user a spinner. Read in a browser this reads exactly
 * as intended: `ApiImplementationError` means the client has a bug, `ApiDependencyError` means the
 * server has one.
 *
 * **401 is the exception, and it is why the rule takes a {@link ClientRole}.** A received 401 means
 * "the credential I presented was rejected", and WHOSE credential that was depends on who I am:
 *
 * - an {@link ClientRole.END_USER_CLIENT} (browser bundle, Expo shell, remote MCP client) presented
 *   the USER's session, so a 401 carrying the webpieces `unauthorized` payload is decoded as
 *   {@link ApiUnauthorizedError}: "log in again" (and, for a remote MCP client, "go find the
 *   authorization server"), not a bug.
 * - a {@link ClientRole.SERVER} presented ITS OWN credential, so a 401 stays
 *   {@link ApiImplementationError} -> a 500 to its own caller. Relaying it as 401 would tell the
 *   browser "your session expired" and log the user out for a backend misconfiguration, and it would
 *   stop paging the team whose credential is broken.
 *
 * Every other status reads the same in both roles, so the role is consulted for 401 alone. The role
 * has no default: each client states it at setup (see {@link ClientRole}).
 *
 * An app that genuinely wants a peer's status relayed as its OWN typed error says so out loud, in one
 * greppable place, by throwing it from its registered translator's `fromWire`.
 */
export class ReceivedApiErrorRule {
    /**
     * @param role - who received it, declared at the client's setup. Decides what a 401 means.
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
        role: ClientRole,
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
            decoded !== undefined &&
            ReceivedApiErrorRule.passesThrough(role, statusCode, decoded)
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

    /**
     * The peer's own typed error, rethrown AS-IS, when re-classifying it would change its meaning:
     *
     * - {@link ApiClientTooOldError}: an upgrade, never a bug, on every hop and for every role.
     * - a 401 {@link ApiUnauthorizedError} received by an END-USER client: the credential it sent IS
     *   the user's session, so this is "log in again". A SERVER's 401 is its own bug and falls through.
     * - a dependency failure: already attributed further downstream.
     */
    // webpieces-disable no-function-outside-class -- stateless shared rule, called by both protocol translators
    private static passesThrough(role: ClientRole, statusCode: number, decoded: Error): boolean {
        if (decoded instanceof ApiClientTooOldError) return true;
        if (statusCode === 401 && decoded instanceof ApiUnauthorizedError) {
            return role === ClientRole.END_USER_CLIENT;
        }
        return (
            decoded instanceof ApiDependencyError ||
            decoded instanceof ApiBadGatewayError ||
            decoded instanceof ApiUnavailableError ||
            decoded instanceof ApiDependencyTimeoutError ||
            decoded instanceof ApiDependencyBackoffError
        );
    }
}
