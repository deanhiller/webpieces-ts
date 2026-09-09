import { describe, expect, it } from 'vitest';
import {
    ApiErrorCodec,
    ApiError,
    BadRequestError,
    UserError,
    UnauthorizedError,
    ForbiddenError,
    NotFoundError,
    EndpointNotFoundError,
    RequestTimeoutError,
    TooManyRequestsError,
    InternalError,
    BadGatewayError,
    ServiceUnavailableError,
    GatewayTimeoutError,
    VendorError,
    OfflineError,
} from './index';
import * as legacy from '../http/errors';

const categories = [
    BadRequestError,
    UserError,
    UnauthorizedError,
    ForbiddenError,
    NotFoundError,
    EndpointNotFoundError,
    RequestTimeoutError,
    TooManyRequestsError,
    InternalError,
    BadGatewayError,
    ServiceUnavailableError,
    GatewayTimeoutError,
    VendorError,
    OfflineError,
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
    });
    it('preserves safe structured fields and omits sensitive diagnostics', () => {
        const user = new UserError(
            'Passwords do not match',
            'mismatch',
            new Error('private database password'),
        );
        const payload = ApiErrorCodec.encode(user);
        expect(ApiErrorCodec.decode(payload)).toMatchObject({
            message: user.message,
            errorCode: 'mismatch',
        });
        expect(JSON.stringify(payload)).not.toContain('private database');
        const bad = new BadRequestError(
            'private operator diagnostic',
            'password',
            'Choose a longer password',
            new Error('private cause'),
        );
        expect(ApiErrorCodec.decode(ApiErrorCodec.encode(bad))).toMatchObject({
            field: 'password',
            guiMessage: 'Choose a longer password',
            message: 'Bad Request',
        });
        expect(
            ApiErrorCodec.decode(ApiErrorCodec.encode(new VendorError('private upstream URL', 90))),
        ).toMatchObject({ waitSeconds: 90 });
        expect(
            ApiErrorCodec.decode(
                ApiErrorCodec.encode(new UnauthorizedError('internal', 'expired')),
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
            expect(ApiErrorCodec.decode(value)).toBeInstanceOf(InternalError);
        }
        expect(ApiErrorCodec.encode('secret')).toMatchObject({
            kind: 'internal',
            message: 'Internal Error',
        });
        expect(
            ApiErrorCodec.decode({ kind: 'user', message: 'x'.repeat(5000), errorCode: 42 }),
        ).toMatchObject({ message: 'x'.repeat(4096), errorCode: undefined });
        expect(ApiErrorCodec.encode(new VendorError('x', Infinity)).waitSeconds).toBeUndefined();
        expect(ApiErrorCodec.encode(new VendorError('x', 100000)).waitSeconds).toBe(86400);
    });
    it('retains only safe bounded semantic causes, including cyclic and hostile wire graphs', () => {
        const cause = new UserError('Correct this input', 'input');
        const original = new InternalError('secret connection details', cause);
        const decoded = ApiErrorCodec.decode(
            JSON.parse(JSON.stringify(ApiErrorCodec.encode(original))),
        );
        expect(decoded.cause).toBeInstanceOf(UserError);
        expect(decoded.cause).toMatchObject({ message: 'Correct this input', errorCode: 'input' });
        Object.defineProperty(cause, 'cause', { value: original });
        const cyclic = ApiErrorCodec.encode(original);
        expect(cyclic.cause?.cause?.cause?.cause).toBeUndefined();
        expect(JSON.stringify(cyclic)).not.toContain('secret connection');
        const wire = { kind: 'internal', cause: {} };
        wire.cause = wire;
        const bounded = ApiErrorCodec.decode(wire);
        expect((bounded.cause as Error).cause).toBeInstanceOf(InternalError);
        expect((((bounded.cause as Error).cause as Error).cause as Error).cause).toBeUndefined();
        expect(
            ApiErrorCodec.decode({
                kind: 'user',
                get cause() {
                    throw new Error('getter must not execute');
                },
            }),
        ).toBeInstanceOf(UserError);
    });
    it('deprecated leaf names refer to exactly the canonical constructor', () => {
        expect(legacy.HttpUserError).toBe(UserError);
        expect(legacy.HttpBadRequestError).toBe(BadRequestError);
        expect(legacy.HttpUnauthorizedError).toBe(UnauthorizedError);
        expect(legacy.HttpForbiddenError).toBe(ForbiddenError);
        expect(legacy.HttpNotFoundError).toBe(NotFoundError);
        expect(legacy.HttpTimeoutError).toBe(RequestTimeoutError);
        expect(legacy.HttpTooManyRequestsError).toBe(TooManyRequestsError);
        expect(legacy.HttpInternalServerError).toBe(InternalError);
        expect(legacy.HttpBadGatewayError).toBe(BadGatewayError);
        expect(legacy.HttpServiceUnavailableError).toBe(ServiceUnavailableError);
        expect(legacy.HttpGatewayTimeoutError).toBe(GatewayTimeoutError);
        expect(legacy.HttpVendorError).toBe(VendorError);
        const cause = new Error('local');
        const custom = new legacy.HttpError('custom', 499, 'custom-kind', cause);
        expect(custom).toBeInstanceOf(ApiError);
        expect(custom.cause).toBe(cause);
        expect(custom.httpCause).toBe(cause);
        expect(custom.code).toBe(499);
    });
});
