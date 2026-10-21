import {
    ApiDependencyBackoffError,
    ApiDependencyError,
    ApiDependencyTimeoutError,
    ApiUnavailableError,
} from '@webpieces/core-util';
import { TaskAlreadyExistsError } from './TaskAlreadyExistsError';

/**
 * Translates a gRPC failure from the Cloud Tasks API into the portable webpieces error taxonomy, so
 * the ONE classifier (`ClientRegistry.classify`) — and therefore `RetryStrategy` and `LogApiCall` —
 * judges an enqueue exactly like any other call:
 *
 * | gRPC code | becomes | outcome |
 * |---|---|---|
 * | 14 UNAVAILABLE (connection reset, channel down) | `ApiUnavailableError` | transient |
 * | 4 DEADLINE_EXCEEDED | `ApiDependencyTimeoutError` | transient |
 * | 8 RESOURCE_EXHAUSTED (quota, throttling) | `ApiDependencyBackoffError` | transient |
 * | 6 ALREADY_EXISTS | `TaskAlreadyExistsError` | success, see that class |
 * | anything else | `ApiDependencyError` | failure |
 *
 * The original gRPC error is kept as `cause`. An error with no numeric gRPC `code` (a local failure
 * before any RPC was sent) is returned unchanged.
 */
export class GrpcErrorMapper {
    static readonly DEADLINE_EXCEEDED = 4;
    static readonly ALREADY_EXISTS = 6;
    static readonly RESOURCE_EXHAUSTED = 8;
    static readonly UNAVAILABLE = 14;

    /**
     * @param error - the already-normalized error `createTask` rejected with
     * @param taskName - the full task name that was sent, reported by an ALREADY_EXISTS
     */
    map(error: Error, taskName: string | undefined): Error {
        const code = Object.getOwnPropertyDescriptor(error, 'code')?.value;
        if (typeof code !== 'number') {
            return error;
        }
        const message = `Cloud Tasks createTask failed with gRPC ${code}: ${error.message}`;
        switch (code) {
            case GrpcErrorMapper.UNAVAILABLE:
                return new ApiUnavailableError(message, error);
            case GrpcErrorMapper.DEADLINE_EXCEEDED:
                return new ApiDependencyTimeoutError(message, error);
            case GrpcErrorMapper.RESOURCE_EXHAUSTED:
                return new ApiDependencyBackoffError(message, 30, error);
            case GrpcErrorMapper.ALREADY_EXISTS:
                return new TaskAlreadyExistsError(taskName ?? 'unknown', error);
            default:
                return new ApiDependencyError(message, error);
        }
    }
}
