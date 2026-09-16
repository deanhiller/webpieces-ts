import { describe, it, expect } from 'vitest';
import { WEBPIECES_DEFAULT_FAILURE_CLASSIFIER } from '../WebpiecesDefaultFailureClassifier';
import { ApiMethodInfo } from '../ApiMethodInfo';
import {
    ApiBadRequestError,
    ApiUnauthorizedError,
    ApiForbiddenError,
    ApiNotFoundError,
    ApiRequestTimeoutError,
    ApiImplementationError,
    ApiEndUserError,
    ApiRateLimitedError,
    ApiDependencyError,
    ApiConflictError,
    ApiUnprocessableError,
    ApiPreconditionFailedError,
    ApiUnsupportedMediaTypeError,
    ApiNotImplementedError,
    ApiCodedError,
} from '../../errors';

const server = new ApiMethodInfo('server', 'SaveApi', 'save');
const client = new ApiMethodInfo('client', 'SaveApi', 'save');
const isFailure = (error: Error, m: ApiMethodInfo): boolean | undefined =>
    WEBPIECES_DEFAULT_FAILURE_CLASSIFIER.isFailure(error, m);

/**
 * The webpieces built-in tier — the single source of truth the old `LogApiCall.isUserError` now
 * delegates to. Guards the exact historical table, especially the 408-is-a-failure carve-out.
 */
describe('WebpiecesDefaultFailureClassifier', () => {
    it('ApiEndUserError (266) is a non-failure on BOTH sides', () => {
        expect(isFailure(new ApiEndUserError('x'), server)).toBe(false);
        expect(isFailure(new ApiEndUserError('x'), client)).toBe(false);
    });

    it('SERVER: 400/401/403/404 are healthy rejections → non-failure', () => {
        expect(isFailure(new ApiBadRequestError('x'), server)).toBe(false);
        expect(isFailure(new ApiUnauthorizedError('x'), server)).toBe(false);
        expect(isFailure(new ApiForbiddenError('x'), server)).toBe(false);
        expect(isFailure(new ApiNotFoundError('x'), server)).toBe(false);
    });

    it('SERVER: 409/412/415/422 are healthy rejections → non-failure', () => {
        expect(isFailure(new ApiConflictError('x'), server)).toBe(false);
        expect(isFailure(new ApiPreconditionFailedError('x'), server)).toBe(false);
        expect(isFailure(new ApiUnsupportedMediaTypeError('x'), server)).toBe(false);
        expect(isFailure(new ApiUnprocessableError('x'), server)).toBe(false);
    });

    it('SERVER: 501 not-implemented is a failure', () => {
        expect(isFailure(new ApiNotImplementedError('x'), server)).toBe(true);
    });

    it('SERVER: a 4xx ApiCodedError is a caller error; 408/429 mirror their named kinds', () => {
        expect(isFailure(new ApiCodedError('x', 460), server)).toBe(false);
        expect(isFailure(new ApiCodedError('x', 409), server)).toBe(false);
        expect(isFailure(new ApiCodedError('x', 408), server)).toBe(
            isFailure(new ApiRequestTimeoutError('x'), server),
        );
        expect(isFailure(new ApiCodedError('x', 429), server)).toBe(
            isFailure(new ApiRateLimitedError('x'), server),
        );
    });

    it('SERVER: a 5xx ApiCodedError is a server/dependency fault', () => {
        expect(isFailure(new ApiCodedError('x', 500), server)).toBe(true);
        expect(isFailure(new ApiCodedError('x', 507), server)).toBe(true);
        expect(isFailure(new ApiCodedError('x', 502), server)).toBe(
            isFailure(new ApiDependencyError('x'), server),
        );
    });

    it('CLIENT: new named and coded errors are failures like every other non-266', () => {
        expect(isFailure(new ApiConflictError('x'), client)).toBe(true);
        expect(isFailure(new ApiCodedError('x', 460), client)).toBe(true);
    });

    it('SERVER: 408 (timeout) is deliberately a FAILURE — the client may never have seen a response', () => {
        expect(isFailure(new ApiRequestTimeoutError('x'), server)).toBe(true);
    });

    it('SERVER: implementation and non-API errors are failures', () => {
        expect(isFailure(new ApiImplementationError('x'), server)).toBe(true);
        expect(isFailure(new Error('boom'), server)).toBe(true);
    });

    it('CLIENT: any error except 266 is a failure (the outbound call failed)', () => {
        expect(isFailure(new ApiBadRequestError('x'), client)).toBe(true);
        expect(isFailure(new ApiNotFoundError('x'), client)).toBe(true);
        expect(isFailure(new Error('boom'), client)).toBe(true);
    });

    it('never defers — always returns a definitive boolean (it is the terminal tier)', () => {
        expect(isFailure(new Error('boom'), server)).not.toBeUndefined();
        expect(isFailure(new Error('boom'), client)).not.toBeUndefined();
    });
});
