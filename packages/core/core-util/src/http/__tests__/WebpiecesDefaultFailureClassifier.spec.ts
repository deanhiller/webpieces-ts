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
