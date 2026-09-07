import { CallContext } from './CallStrategy';

/** Stopped waiting; this does not prove the remote operation did not run. */
export class TimeoutError extends Error {
    constructor(
        public readonly timeoutMs: number,
        public readonly context: CallContext,
    ) {
        super(`${context.apiName}.${context.methodName} timed out after ${timeoutMs}ms`);
        this.name = 'TimeoutError';
    }
}
