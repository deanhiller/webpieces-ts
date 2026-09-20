import { describe, it, expect } from 'vitest';
import {
    ApiBadRequestError,
    ApiCodedError,
    ApiDependencyError,
    ApiEndUserError,
    ApiImplementationError,
    ApiNotFoundError,
} from '../../errors/ApiError';
import { ApiErrorCodec, ApiErrorPayload } from '../../errors/ApiErrorCodec';
import { toError } from '../../lib/errorUtils';
import { HttpResponseDto, HttpResponseStatus } from '../HttpResponseDto';
import { SurfaceEndUserStatus } from '../Surface';
import { WebpiecesDefaultErrorTranslator } from '../WebpiecesDefaultErrorTranslator';

const translator = new WebpiecesDefaultErrorTranslator();

const response = (code: number, body: unknown = undefined, reason = ''): HttpResponseDto =>
    new HttpResponseDto(new HttpResponseStatus(code, reason), [], body);

/** What a webpieces PEER actually puts on the wire for `error`, so these are round-trip tests. */
const wireOf = (error: Error): HttpResponseDto => translator.toWire(error);

const caught = (dto: HttpResponseDto): Error => {
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- this spec IS the catch
    try {
        translator.fromWire(dto);
    } catch (err: unknown) {
        const error = toError(err);
        return error;
    }
    throw new Error(`fromWire returned for HTTP ${dto.status.code}; it was expected to throw`);
};

/**
 * THE uniform rule, in the one place it is decided. Issue #968: an earlier design made the BROWSER
 * pass a received status through unchanged, on the theory that the browser is the user's agent. It
 * is not — if a browser received a 404 the browser called the wrong path, which is the browser's
 * bug. So node and browser share one class and one rule.
 */
describe('WebpiecesDefaultErrorTranslator.fromWire — the uniform received-status rule', () => {
    it('4xx received -> ApiImplementationError: I sent a bad request, MY bug', () => {
        for (const code of [400, 401, 403, 404, 409, 415, 422, 429]) {
            const error = caught(response(code, undefined, 'Nope'));
            expect(error, `HTTP ${code}`).toBeInstanceOf(ApiImplementationError);
        }
    });

    it('5xx received -> ApiDependencyError: THEY broke, so this service keeps clean metrics', () => {
        for (const code of [500, 501, 503, 504]) {
            const error = caught(response(code, undefined, 'Boom'));
            expect(error, `HTTP ${code}`).toBeInstanceOf(ApiDependencyError);
        }
    });

    it('an incoming ApiDependencyError is rethrown AS-IS — the fault is already attributed', () => {
        const wire = wireOf(new ApiDependencyError('payments is down'));
        expect(wire.status.code).toBe(502);

        const error = caught(wire);
        expect(error).toBeInstanceOf(ApiDependencyError);
        // The PEER genericized the text (`ApiErrorBoundary` publishes only an ApiEndUserError's own
        // message), so what comes back is the generic one — but it comes back UNWRAPPED.
        expect(error.message).toBe('Dependency Error');
        // Not re-wrapped: a chain of hops must not bury the original one `cause` deeper each time.
        expect(error.message).not.toContain('dependency answered');
    });

    it('266 -> ApiEndUserError, message published verbatim, errorCode intact', () => {
        const wire = wireOf(new ApiEndUserError('Those passwords do not match', 'pw_mismatch'));
        expect(wire.status.code).toBe(266);

        const error = caught(wire);
        expect(error).toBeInstanceOf(ApiEndUserError);
        expect(error.message).toBe('Those passwords do not match');
        expect((error as ApiEndUserError).errorCode).toBe('pw_mismatch');
    });

    it('a peer ApiNotFoundError does NOT come back as ApiNotFoundError — 404 is 4xx, so it is MY bug', () => {
        const error = caught(wireOf(new ApiNotFoundError('no such order')));

        expect(error).toBeInstanceOf(ApiImplementationError);
        // The operator text did not cross the wire at all — `ApiErrorBoundary` publishes only the
        // generic reason for a non-end-user error — but the STATUS is carried into the message, which
        // is the part that tells this service which of its own calls was wrong.
        expect(error.message).not.toContain('no such order');
        expect(error.message).toContain('404');
    });

    it('a 4xx ApiCodedError is still MY bug, and its own status is carried in the message', () => {
        const error = caught(wireOf(new ApiCodedError('contract suspended', 460)));

        expect(error).toBeInstanceOf(ApiImplementationError);
        expect(error.message).toContain('460');
    });

    it('a foreign responder with no webpieces payload is classified on the status alone', () => {
        const error = caught(response(418, 'I am a teapot', "I'm a teapot"));

        expect(error).toBeInstanceOf(ApiImplementationError);
        expect(error.message).toContain("I'm a teapot");
    });

    it('a body whose kind DISAGREES with the status is not believed; the status decides', () => {
        const payload = new ApiErrorPayload('not-found', 'claims 404');
        const error = caught(response(500, payload));

        // The body says not-found (404), the status says 500. 500 wins -> the peer broke.
        expect(error).toBeInstanceOf(ApiDependencyError);
    });
});

describe('WebpiecesDefaultErrorTranslator.fromWire — every response, 2xx included', () => {
    it('an ordinary 2xx returns SILENTLY, so the caller gets its DTO', () => {
        for (const code of [200, 201, 202, 204]) {
            expect(
                () => translator.fromWire(response(code, { ok: true })),
                `HTTP ${code}`,
            ).not.toThrow();
        }
    });

    it('266 is the one 2xx that throws — protocol success, expected user exception', () => {
        expect(() => translator.fromWire(wireOf(new ApiEndUserError('nope')))).toThrow(
            ApiEndUserError,
        );
    });

    it('an APP translator can turn a 200 into a throw, which is why 2xx reaches the seam at all', () => {
        class PaymentDeclined extends Error {}
        const appTranslator = {
            toWire: (error: Error): HttpResponseDto => translator.toWire(error),
            fromWire: (dto: HttpResponseDto): void => {
                if (ApiErrorCodec.isPayload(dto.body)) {
                    translator.fromWire(dto);
                    return;
                }
                const body = dto.body as { status?: string } | undefined;
                if (body?.status === 'DECLINED') throw new PaymentDeclined('card declined');
                translator.fromWire(dto);
            },
        };

        expect(() => appTranslator.fromWire(response(200, { status: 'DECLINED' }))).toThrow(
            PaymentDeclined,
        );
        expect(() => appTranslator.fromWire(response(200, { status: 'OK' }))).not.toThrow();
    });
});

describe('WebpiecesDefaultErrorTranslator.toWire', () => {
    it('publishes an ApiEndUserError at 266 ALWAYS — the caller surface decides any republish', () => {
        const wire = wireOf(new ApiEndUserError('no such report', 'report_not_found', 404));

        expect(wire.status.code).toBe(266);
        expect((wire.body as ApiErrorPayload).edgeHttpStatus).toBe(404);
    });

    it('publishes an unknown throw as a generic 500, disclosing nothing', () => {
        const wire = wireOf(new Error('connection string is postgres://user:hunter2@db'));

        expect(wire.status.code).toBe(500);
        expect(JSON.stringify(wire.body)).not.toContain('hunter2');
    });

    it('writes no headers when the payload asks for none', () => {
        const wire = wireOf(new ApiBadRequestError('bad'));
        expect(wire.status.code).toBe(400);
        expect(wire.headers).toEqual([]);
    });
});

/**
 * The per-request replacement for the deleted per-router `EndUserStatus`. `gui` and `llm` are both
 * webpieces clients that DECODE the body, so both keep 266; only a partner REST edge gets a real
 * status, and an absent surface behaves exactly as the old `'gui'` default did.
 */
describe('SurfaceEndUserStatus', () => {
    it('gui -> 266', () => {
        expect(SurfaceEndUserStatus.statusFor('gui', 404)).toBe(266);
    });

    it('llm -> 266 (the MCP bridge renders the result itself)', () => {
        expect(SurfaceEndUserStatus.statusFor('llm', 404)).toBe(266);
    });

    it("public-api -> the thrower's edgeHttpStatus", () => {
        expect(SurfaceEndUserStatus.statusFor('public-api', 409)).toBe(409);
    });

    it('public-api with no edgeHttpStatus -> 400, still a caller-fixable outcome', () => {
        expect(SurfaceEndUserStatus.statusFor('public-api', undefined)).toBe(400);
    });

    it('ABSENT -> 266, preserving the behaviour of a public or non-webpieces caller', () => {
        expect(SurfaceEndUserStatus.statusFor(undefined, 422)).toBe(266);
    });
});
