import { describe, expect, it } from 'vitest';
import {
    ApiErrorCodec,
    ApiError,
    ApiBadRequestError,
    ApiEndUserError,
    ApiUnauthorizedError,
    ApiForbiddenError,
    ApiNotFoundError,
    ApiEndpointNotFoundError,
    ApiRequestTimeoutError,
    ApiRateLimitedError,
    ApiImplementationError,
    ApiDependencyError,
    ApiUnavailableError,
    ApiDependencyTimeoutError,
    ApiDependencyBackoffError,
    ApiConnectionError,
    ApiConflictError,
    ApiUnprocessableError,
    ApiPreconditionFailedError,
    ApiUnsupportedMediaTypeError,
    ApiNotImplementedError,
    ApiCodedError,
} from './index';
import { toError } from '../lib/errorUtils';

const categories = [
    ApiBadRequestError,
    ApiEndUserError,
    ApiUnauthorizedError,
    ApiForbiddenError,
    ApiNotFoundError,
    ApiEndpointNotFoundError,
    ApiRequestTimeoutError,
    ApiRateLimitedError,
    ApiImplementationError,
    ApiDependencyError,
    ApiUnavailableError,
    ApiDependencyTimeoutError,
    ApiDependencyBackoffError,
    ApiConnectionError,
    ApiConflictError,
    ApiUnprocessableError,
    ApiPreconditionFailedError,
    ApiUnsupportedMediaTypeError,
    ApiNotImplementedError,
];
describe('canonical error codec', () => {
    it.each(categories)('round-trips %s with canonical identity across JSON', (Constructor) => {
        const error = new Constructor('private operator detail');
        const decoded = ApiErrorCodec.decode(
            JSON.parse(JSON.stringify(ApiErrorCodec.encode(error))),
        );
        expect(decoded).toBeInstanceOf(Constructor);
        expect(decoded).toBeInstanceOf(ApiError);
        expect(decoded).not.toHaveProperty('code');
        if (decoded instanceof ApiImplementationError) expect(decoded.serverError).toBe(true);
    });
    it('preserves safe structured fields and omits sensitive diagnostics', () => {
        const user = new ApiEndUserError(
            'Passwords do not match',
            'mismatch',
            409,
            new Error('private database password'),
        );
        const payload = ApiErrorCodec.encode(user);
        expect(ApiErrorCodec.decode(payload)).toMatchObject({
            message: user.message,
            errorCode: 'mismatch',
            edgeHttpStatus: 409,
        });
        expect(JSON.stringify(payload)).not.toContain('private database');
        const bad = new ApiBadRequestError(
            'private operator diagnostic',
            'password',
            'Choose a longer password',
            new Error('private cause'),
        );
        expect(ApiErrorCodec.decode(ApiErrorCodec.encode(bad))).toMatchObject({
            field: 'password',
            callerMessage: 'Choose a longer password',
            message: 'Bad Request',
        });
        expect(
            ApiErrorCodec.decode(
                ApiErrorCodec.encode(new ApiDependencyBackoffError('private upstream URL', 90)),
            ),
        ).toMatchObject({ retryAfterSeconds: 90 });
        expect(
            ApiErrorCodec.decode(
                ApiErrorCodec.encode(new ApiUnauthorizedError('internal', 'expired')),
            ),
        ).toMatchObject({ subType: 'expired' });
        expect(JSON.stringify(ApiErrorCodec.encode(bad))).not.toMatch(/stack|private/);
    });
    it('never constructs remote classes, bounds fields and normalizes unknown failures', () => {
        for (const value of [
            null,
            false,
            'failure',
            { kind: 'eval', message: 'remote executable' },
            { kind: '__proto__' },
        ]) {
            expect(ApiErrorCodec.decode(value)).toBeInstanceOf(ApiImplementationError);
        }
        // `encode` takes an `Error` now, so a bare thrown value narrows with `toError` first —
        // exactly what every catch in the framework already does — and still discloses nothing.
        expect(ApiErrorCodec.encode(toError('secret'))).toMatchObject({
            kind: 'implementation',
            message: 'Internal Error',
        });
        expect(
            ApiErrorCodec.decode({ kind: 'end-user', message: 'x'.repeat(5000), errorCode: 42 }),
        ).toMatchObject({ message: 'x'.repeat(4096), errorCode: undefined });
        expect(
            ApiErrorCodec.encode(new ApiDependencyBackoffError('x', Infinity)).retryAfterSeconds,
        ).toBeUndefined();
        expect(
            ApiErrorCodec.encode(new ApiDependencyBackoffError('x', 100000)).retryAfterSeconds,
        ).toBe(86400);
    });
    it('round-trips ApiEndUserError.edgeHttpStatus across JSON for every allowed status', () => {
        for (const status of [400, 404, 409, 422] as const) {
            const wire = JSON.parse(
                JSON.stringify(ApiErrorCodec.encode(new ApiEndUserError('msg', 'code', status))),
            );
            expect(wire.edgeHttpStatus).toBe(status);
            const decoded = ApiErrorCodec.decode(wire) as ApiEndUserError;
            expect(decoded).toBeInstanceOf(ApiEndUserError);
            expect(decoded.edgeHttpStatus).toBe(status);
        }
    });
    it('omits edgeHttpStatus from the wire when the thrower set none', () => {
        const wire = JSON.parse(JSON.stringify(ApiErrorCodec.encode(new ApiEndUserError('m'))));
        expect(wire).not.toHaveProperty('edgeHttpStatus');
    });
    it('decodes an older peer (no edgeHttpStatus) or an illegal one as undefined', () => {
        const older = ApiErrorCodec.decode({ kind: 'end-user', message: 'm', errorCode: 'c' });
        expect(older).toBeInstanceOf(ApiEndUserError);
        expect((older as ApiEndUserError).edgeHttpStatus).toBeUndefined();
        expect((older as ApiEndUserError).errorCode).toBe('c');
        for (const bad of [500, 401, 403, 429, 266, '404', 404.5, null]) {
            const decoded = ApiErrorCodec.decode({
                kind: 'end-user',
                message: 'm',
                edgeHttpStatus: bad,
            });
            expect((decoded as ApiEndUserError).edgeHttpStatus).toBeUndefined();
        }
    });
    it('retains only safe bounded semantic causes, including cyclic and hostile wire graphs', () => {
        const cause = new ApiEndUserError('Correct this input', 'input');
        const original = new ApiImplementationError('secret connection details', cause);
        const decoded = ApiErrorCodec.decode(
            JSON.parse(JSON.stringify(ApiErrorCodec.encode(original))),
        );
        expect(decoded.cause).toBeInstanceOf(ApiEndUserError);
        expect(decoded.cause).toMatchObject({ message: 'Correct this input', errorCode: 'input' });
        Object.defineProperty(cause, 'cause', { value: original });
        const cyclic = ApiErrorCodec.encode(original);
        expect(cyclic.cause?.cause?.cause?.cause).toBeUndefined();
        expect(JSON.stringify(cyclic)).not.toContain('secret connection');
        const wire = { kind: 'implementation', cause: {} };
        wire.cause = wire;
        const bounded = ApiErrorCodec.decode(wire);
        expect((bounded.cause as Error).cause).toBeInstanceOf(ApiImplementationError);
        expect((((bounded.cause as Error).cause as Error).cause as Error).cause).toBeUndefined();
        expect(
            ApiErrorCodec.decode({
                kind: 'end-user',
                get cause() {
                    throw new Error('getter must not execute');
                },
            }),
        ).toBeInstanceOf(ApiEndUserError);
    });
    it('round-trips ApiCodedError statusCode and errorCode across JSON, message stays generic', () => {
        const error = new ApiCodedError('private operator detail', 460, 'QUOTA_SHAPE');
        const payload = JSON.parse(JSON.stringify(ApiErrorCodec.encode(error)));
        expect(payload).toMatchObject({ kind: 'coded', statusCode: 460, errorCode: 'QUOTA_SHAPE' });
        expect(JSON.stringify(payload)).not.toContain('private operator');
        const decoded = ApiErrorCodec.decode(payload);
        expect(decoded).toBeInstanceOf(ApiCodedError);
        expect(decoded).toMatchObject({
            statusCode: 460,
            errorCode: 'QUOTA_SHAPE',
            message: 'Request Failed',
        });
        expect(ApiErrorCodec.isPayload(payload)).toBe(true);
    });
    it('accepts a coded status a named class already owns', () => {
        const decoded = ApiErrorCodec.decode(ApiErrorCodec.encode(new ApiCodedError('x', 404)));
        expect(decoded).toBeInstanceOf(ApiCodedError);
        expect((decoded as ApiCodedError).statusCode).toBe(404);
    });
    it('normalizes a coded payload with an illegal statusCode to a remote implementation failure', () => {
        for (const statusCode of [undefined, 99, 600, 404.5, '404', Number.NaN]) {
            const decoded = ApiErrorCodec.decode({ kind: 'coded', statusCode });
            expect(decoded).toBeInstanceOf(ApiImplementationError);
            expect((decoded as ApiImplementationError).serverError).toBe(true);
        }
    });
    it('ApiCodedError.isStatusCode accepts integers 100-599 only', () => {
        for (const ok of [100, 266, 460, 599]) expect(ApiCodedError.isStatusCode(ok)).toBe(true);
        for (const bad of [99, 600, 404.5, -1, Infinity, '404', null])
            expect(ApiCodedError.isStatusCode(bad)).toBe(false);
    });
    it('marks only remotely decoded implementation failures as server errors', () => {
        const local = new ApiImplementationError('local bug');
        const remote = ApiErrorCodec.decode(ApiErrorCodec.encode(local));
        expect(local.serverError).toBe(false);
        expect(remote).toBeInstanceOf(ApiImplementationError);
        expect((remote as ApiImplementationError).serverError).toBe(true);
    });
});
