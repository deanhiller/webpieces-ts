import { Logger } from '../logging/Logger';
import { toError } from '../lib/errorUtils';
import { ApiErrorCodec, ApiErrorPayload } from './ApiErrorCodec';
import {
    ApiBadRequestError,
    ApiCodedError,
    ApiConflictError,
    ApiConnectionError,
    ApiEndUserError,
    ApiError,
    ApiForbiddenError,
    ApiNotFoundError,
    ApiPreconditionFailedError,
    ApiRequestTimeoutError,
    ApiUnauthorizedError,
    ApiUnprocessableError,
    ApiUnsupportedMediaTypeError,
} from './ApiError';

/**
 * The ONE rule every outbound protocol boundary (HTTP server, MCP) applies to a thrown value before
 * rendering it, plus the one operator log line per failure. Adapters differ only in the wire shape
 * they render; classification and log levels live here so they cannot drift apart.
 *
 * Nothing here SUBSTITUTES an object for the value that was thrown: the thrown error survives to
 * every consumer, so an app can still `instanceof` its own error class and the operator log still
 * names it. Classification is a VALUE computed from the thrown error, never a wrapper around it.
 */
export class ApiErrorBoundary {
    constructor(private readonly log: Logger) {}

    /**
     * The classified API outcome `thrown` publishes as, or `undefined` when it is a bug or broken
     * state of THIS service — a non-`ApiError`, a non-`Error` throw, or a caller-local
     * `ApiConnectionError`.
     *
     * A connection failure is OUR outbound call failing, so from our caller's seat this service is
     * the thing that is broken: it publishes as `implementation`, never as `connection`. That rule
     * is deliberately NOT in `ApiErrorCodec`, which encodes a value faithfully; it belongs to the
     * boundary that owns the failure.
     *
     * The returned error IS the thrown error — never a replacement.
     */
    // webpieces-disable no-any-unknown -- thrown values are unknown until classified at this boundary
    apiOutcome(thrown: unknown): ApiError | undefined {
        if (thrown instanceof ApiError && !(thrown instanceof ApiConnectionError)) return thrown;
        return undefined;
    }

    /**
     * The wire payload THIS service publishes for `thrown`. Only an {@link ApiEndUserError} ever
     * publishes its own message; everything else gets allowlisted generic text by kind.
     */
    // webpieces-disable no-any-unknown -- thrown values are unknown until classified at this boundary
    encode(thrown: unknown): ApiErrorPayload {
        const outcome = this.apiOutcome(thrown);
        if (!outcome) return new ApiErrorPayload('implementation', 'Internal Error');
        return ApiErrorCodec.encode(outcome);
    }

    /**
     * Logs one operator line at the per-kind level: expected caller outcomes at info, everything else
     * at error. `correlation` is appended verbatim (for example `requestId=... tool=...`).
     *
     * The line names the class that was ACTUALLY thrown, which is the single fact an operator needs
     * and the one a wrapper would have destroyed.
     */
    // webpieces-disable no-any-unknown -- thrown values are unknown until classified at this boundary
    logOperatorDetail(thrown: unknown, correlation?: string): void {
        const suffix = correlation ? ` ${correlation}` : '';
        const detail = `${this.operatorDetail(thrown)}${suffix}`;
        if (thrown instanceof ApiEndUserError) this.log.info(`End User Error: ${detail}`);
        else if (thrown instanceof ApiBadRequestError) this.log.info(`Bad Request: ${detail}`);
        else if (thrown instanceof ApiNotFoundError) this.log.info(`Not Found: ${detail}`);
        else if (thrown instanceof ApiUnauthorizedError) this.log.info(`Unauthorized: ${detail}`);
        else if (thrown instanceof ApiForbiddenError) this.log.info(`Forbidden: ${detail}`);
        else if (thrown instanceof ApiConflictError) this.log.info(`Conflict: ${detail}`);
        else if (thrown instanceof ApiUnprocessableError) this.log.info(`Unprocessable: ${detail}`);
        else if (thrown instanceof ApiPreconditionFailedError)
            this.log.info(`Precondition Failed: ${detail}`);
        else if (thrown instanceof ApiUnsupportedMediaTypeError)
            this.log.info(`Unsupported Media Type: ${detail}`);
        else if (thrown instanceof ApiCodedError && thrown.isCallerError())
            this.log.info(`Coded ${thrown.statusCode}: ${detail}`);
        else if (thrown instanceof ApiRequestTimeoutError)
            this.log.error(`Request Timeout: ${detail}`);
        else this.log.error(`API failure: ${detail}`);
    }

    // webpieces-disable no-any-unknown -- thrown values are unknown until classified at this boundary
    private operatorDetail(thrown: unknown): string {
        const error = toError(thrown);
        const kind = this.apiOutcome(thrown)?.kind ?? 'implementation';
        const subType = thrown instanceof ApiError ? thrown.subType : undefined;
        const cause = error.cause instanceof Error ? ` cause=${error.cause.message}` : '';
        return `[name=${error.name} kind=${kind} subType=${subType ?? 'none'}] ${error.message}${cause}`;
    }
}
