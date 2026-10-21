import { describe, it, expect } from 'vitest';
import { WEBPIECES_DEFAULT_ERROR_CLASSIFIER } from '../WebpiecesDefaultErrorClassifier';
import { CallOutcome } from '../ErrorClassifier';
import { ApiMethodInfo } from '../ApiMethodInfo';
import { ApiCallTimeoutError } from '../ApiCallTimeoutError';
import { CallContext } from '../CallStrategy';
import { READ } from '../HttpEndpointOptions';
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
    ApiBadGatewayError,
    ApiUnavailableError,
    ApiDependencyTimeoutError,
    ApiDependencyBackoffError,
    ApiConnectionError,
    ApiRetriesExhaustedError,
} from '../../errors';

/** Synthetic contract classes: a call identity always names its contract CLASS (#1350). */
class SaveApi {}

const server = new ApiMethodInfo('server', 'SaveApi', 'save', SaveApi);
const client = new ApiMethodInfo('client', 'SaveApi', 'save', SaveApi);
const classify = (error: Error, m: ApiMethodInfo): CallOutcome =>
    WEBPIECES_DEFAULT_ERROR_CLASSIFIER.classify(error, m);

/**
 * The webpieces built-in tier. Table 1 (EXPECTED or not) is the historical failure table, including
 * the 408-is-not-expected carve-out; table 2 (TRANSIENT or FAILURE) is the kind table that used to
 * live in the MCP renderer.
 */
describe('WebpiecesDefaultErrorClassifier — EXPECTED', () => {
    it('ApiEndUserError (266) is EXPECTED on BOTH sides', () => {
        expect(classify(new ApiEndUserError('x'), server)).toBe(CallOutcome.EXPECTED);
        expect(classify(new ApiEndUserError('x'), client)).toBe(CallOutcome.EXPECTED);
    });

    it('SERVER: 400/401/403/404/409/412/415/422 and a caller-coded 4xx are healthy rejections', () => {
        for (const error of [
            new ApiBadRequestError('x'),
            new ApiUnauthorizedError('x'),
            new ApiForbiddenError('x'),
            new ApiNotFoundError('x'),
            new ApiConflictError('x'),
            new ApiPreconditionFailedError('x'),
            new ApiUnsupportedMediaTypeError('x'),
            new ApiUnprocessableError('x'),
            new ApiCodedError('x', 460),
        ]) {
            expect(classify(error, server)).toBe(CallOutcome.EXPECTED);
        }
    });

    it('SERVER: 408 is deliberately NOT expected — the client may never have seen a response', () => {
        expect(classify(new ApiRequestTimeoutError('x'), server)).toBe(CallOutcome.TRANSIENT_FAILURE);
        expect(classify(new ApiCodedError('x', 408), server)).toBe(CallOutcome.TRANSIENT_FAILURE);
    });

    it('CLIENT: any error except 266 is a failure (the outbound call failed)', () => {
        for (const error of [
            new ApiBadRequestError('x'),
            new ApiNotFoundError('x'),
            new ApiConflictError('x'),
            new ApiCodedError('x', 460),
            new Error('boom'),
        ]) {
            expect(classify(error, client)).toBe(CallOutcome.FAILURE);
        }
    });
});

describe('WebpiecesDefaultErrorClassifier — TRANSIENT_FAILURE vs FAILURE', () => {
    it('timeouts, unavailable, bad-gateway, backoff, rate-limited and connection are TRANSIENT', () => {
        for (const error of [
            new ApiRequestTimeoutError('x'),
            new ApiDependencyTimeoutError('x'),
            new ApiCallTimeoutError(5_000, new CallContext('SaveApi', 'save', READ, SaveApi)),
            new ApiBadGatewayError('x'),
            new ApiUnavailableError('x'),
            new ApiDependencyBackoffError('x'),
            new ApiRateLimitedError('x'),
            new ApiConnectionError('x'),
            new ApiCodedError('x', 429),
        ]) {
            expect(classify(error, client)).toBe(CallOutcome.TRANSIENT_FAILURE);
        }
    });

    it('implementation, 501, a generic dependency defect and a 5xx coded error are FAILURE', () => {
        for (const error of [
            new ApiImplementationError('x'),
            new ApiNotImplementedError('x'),
            new ApiDependencyError('x'),
            new ApiCodedError('x', 500),
            new ApiCodedError('x', 507),
            new Error('boom'),
        ]) {
            expect(classify(error, server)).toBe(CallOutcome.FAILURE);
            expect(classify(error, client)).toBe(CallOutcome.FAILURE);
        }
    });

    it('ApiRetriesExhaustedError is FAILURE, never transient, though it IS an ApiDependencyError', () => {
        const exhausted = new ApiRetriesExhaustedError(4, new ApiUnavailableError('x'));
        expect(exhausted).toBeInstanceOf(ApiDependencyError);
        expect(classify(exhausted, client)).toBe(CallOutcome.FAILURE);
        expect(classify(exhausted, server)).toBe(CallOutcome.FAILURE);
    });
});
