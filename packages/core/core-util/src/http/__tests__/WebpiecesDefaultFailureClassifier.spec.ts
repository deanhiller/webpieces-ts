import { describe, it, expect } from 'vitest';
import { WEBPIECES_DEFAULT_FAILURE_CLASSIFIER } from '../WebpiecesDefaultFailureClassifier';
import { ApiMethodInfo } from '../ApiMethodInfo';
import {
    BadRequestError,
    UnauthorizedError,
    ForbiddenError,
    NotFoundError,
    RequestTimeoutError,
    InternalError,
    UserError,
} from '../errors';

const server = new ApiMethodInfo('server', 'SaveApi', 'save');
const client = new ApiMethodInfo('client', 'SaveApi', 'save');
const isFailure = (error: Error, m: ApiMethodInfo): boolean | undefined =>
    WEBPIECES_DEFAULT_FAILURE_CLASSIFIER.isFailure(error, m);

/**
 * The webpieces built-in tier — the single source of truth the old `LogApiCall.isUserError` now
 * delegates to. Guards the exact historical table, especially the 408-is-a-failure carve-out.
 */
describe('WebpiecesDefaultFailureClassifier', () => {
    it('UserError (266) is a non-failure on BOTH sides', () => {
        expect(isFailure(new UserError('x'), server)).toBe(false);
        expect(isFailure(new UserError('x'), client)).toBe(false);
    });

    it('SERVER: 400/401/403/404 are healthy rejections → non-failure', () => {
        expect(isFailure(new BadRequestError('x'), server)).toBe(false);
        expect(isFailure(new UnauthorizedError('x'), server)).toBe(false);
        expect(isFailure(new ForbiddenError('x'), server)).toBe(false);
        expect(isFailure(new NotFoundError('x'), server)).toBe(false);
    });

    it('SERVER: 408 (timeout) is deliberately a FAILURE — the client may never have seen a response', () => {
        expect(isFailure(new RequestTimeoutError('x'), server)).toBe(true);
    });

    it('SERVER: 5xx and any non-Http Error are failures', () => {
        expect(isFailure(new InternalError('x'), server)).toBe(true);
        expect(isFailure(new Error('boom'), server)).toBe(true);
    });

    it('CLIENT: any error except 266 is a failure (the outbound call failed)', () => {
        expect(isFailure(new BadRequestError('x'), client)).toBe(true);
        expect(isFailure(new NotFoundError('x'), client)).toBe(true);
        expect(isFailure(new Error('boom'), client)).toBe(true);
    });

    it('never defers — always returns a definitive boolean (it is the terminal tier)', () => {
        expect(isFailure(new Error('boom'), server)).not.toBeUndefined();
        expect(isFailure(new Error('boom'), client)).not.toBeUndefined();
    });
});
