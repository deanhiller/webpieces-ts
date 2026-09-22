import { CallContext } from './CallStrategy';
import { ApiDependencyTimeoutError } from '../errors/ApiError';

/** Stopped waiting; this does not prove the remote operation did not run. */
export class ApiCallTimeoutError extends ApiDependencyTimeoutError {
    constructor(
        public readonly timeoutMs: number,
        public readonly context: CallContext,
    ) {
        super(`${context.apiName}.${context.methodName} timed out after ${timeoutMs}ms`);
        this.name = 'ApiCallTimeoutError';
    }
}
