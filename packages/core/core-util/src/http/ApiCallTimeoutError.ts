import { CallContext } from './CallStrategy';
import { ApiDependencyTimeoutError } from '../errors/ApiError';
import { EndpointOperation, WRITE } from './HttpEndpointOptions';

/**
 * Stopped waiting; this does not prove the remote operation did not run.
 *
 * Two audiences, two fields:
 * - `message` is the DEVELOPER text (`SaveApi.save timed out after 30000ms`) for logs and error
 *   reporting. Keep reporting it: a deadline that fires in production is a bug for somebody.
 * - `userMessage` is the stable, calm text an app renders VERBATIM to an end user, in the same
 *   spirit as `ApiBadRequestError.callerMessage`. It is chosen by the endpoint's declared
 *   operation (`context.operation`), because the safe advice differs: a `READ` or
 *   `WRITE_IDEMPOTENT` call is safe to repeat, while a `WRITE` may already have been applied and a
 *   blind retry can apply it twice.
 *
 * A client deadline is not a gateway failure, so an app should never title it "Gateway Timeout";
 * check `instanceof ApiCallTimeoutError` BEFORE the broader `ApiDependencyTimeoutError`.
 */
export class ApiCallTimeoutError extends ApiDependencyTimeoutError {
    /** Shown for `READ` and `WRITE_IDEMPOTENT`: repeating the call is safe. */
    static readonly RETRY_SAFE_USER_MESSAGE =
        'The network timed out. It probably just flaked. Please try your request again.';
    /** Shown for `WRITE`: the change may already have been applied, so check before repeating it. */
    static readonly WRITE_USER_MESSAGE =
        'The network timed out. Your change may or may not have been saved — please check before trying again.';

    /** End-user text, chosen from `context.operation`. `message` stays the developer text. */
    readonly userMessage: string;

    constructor(
        public readonly timeoutMs: number,
        public readonly context: CallContext,
    ) {
        super(`${context.apiName}.${context.methodName} timed out after ${timeoutMs}ms`);
        this.name = 'ApiCallTimeoutError';
        this.userMessage = ApiCallTimeoutError.userMessageFor(context.operation);
    }

    // webpieces-disable no-function-outside-class -- pure operation -> text mapping owned by this error
    private static userMessageFor(operation: EndpointOperation): string {
        return operation === WRITE
            ? ApiCallTimeoutError.WRITE_USER_MESSAGE
            : ApiCallTimeoutError.RETRY_SAFE_USER_MESSAGE;
    }
}
