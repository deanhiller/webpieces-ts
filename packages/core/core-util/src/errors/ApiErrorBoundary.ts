import { Logger } from '../logging/Logger';
import { toError } from '../lib/errorUtils';
import {
    ApiBadRequestError,
    ApiConnectionError,
    ApiEndUserError,
    ApiError,
    ApiForbiddenError,
    ApiImplementationError,
    ApiNotFoundError,
    ApiRequestTimeoutError,
    ApiUnauthorizedError,
} from './ApiError';

/**
 * The ONE rule every outbound protocol boundary (HTTP server, MCP) applies to a thrown value before
 * rendering it, plus the one operator log line per failure. Adapters differ only in the wire shape
 * they render; normalization and log levels live here so they cannot drift apart.
 */
export class ApiErrorBoundary {
    constructor(private readonly log: Logger) {}

    /**
     * An `ApiError` (except a caller-local `ApiConnectionError`) stays as-is. Anything else, including
     * a raw `Error`, a non-Error throw, or a downstream connection failure, is a bug or broken state of
     * THIS service and becomes `ApiImplementationError`. Its message stays operator-only: encoders
     * publish only `ApiEndUserError` text.
     */
    // webpieces-disable no-any-unknown -- thrown values are unknown until normalized at this boundary
    normalize(thrown: unknown): ApiError {
        if (thrown instanceof ApiError && !(thrown instanceof ApiConnectionError)) return thrown;
        const error = toError(thrown);
        return new ApiImplementationError(error.message, error);
    }

    /**
     * Logs one operator line at the per-kind level: expected caller outcomes at info, everything else
     * at error. `correlation` is appended verbatim (for example `requestId=... tool=...`).
     */
    logOperatorDetail(error: ApiError, correlation?: string): void {
        const suffix = correlation ? ` ${correlation}` : '';
        const detail = `${this.operatorDetail(error)}${suffix}`;
        if (error instanceof ApiEndUserError) this.log.info(`End User Error: ${detail}`);
        else if (error instanceof ApiBadRequestError) this.log.info(`Bad Request: ${detail}`);
        else if (error instanceof ApiNotFoundError) this.log.info(`Not Found: ${detail}`);
        else if (error instanceof ApiUnauthorizedError) this.log.info(`Unauthorized: ${detail}`);
        else if (error instanceof ApiForbiddenError) this.log.info(`Forbidden: ${detail}`);
        else if (error instanceof ApiRequestTimeoutError)
            this.log.error(`Request Timeout: ${detail}`);
        else this.log.error(`API failure: ${detail}`);
    }

    private operatorDetail(error: ApiError): string {
        const cause = error.cause instanceof Error ? ` cause=${error.cause.message}` : '';
        return `[name=${error.name} kind=${error.kind} subType=${error.subType ?? 'none'}] ${error.message}${cause}`;
    }
}
