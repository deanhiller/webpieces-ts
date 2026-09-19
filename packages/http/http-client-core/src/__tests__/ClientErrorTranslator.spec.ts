import { describe, it, expect, beforeEach } from 'vitest';
import {
    ClientRegistry,
    ApiErrorPayload,
    ApiErrorCodec,
    ApiBadRequestError,
    ApiNotFoundError,
    ApiEndUserError,
    ApiUnauthorizedError,
    ApiForbiddenError,
    ApiRequestTimeoutError,
    ApiRateLimitedError,
    ApiImplementationError,
    ApiDependencyError,
    ApiUnavailableError,
    ApiDependencyTimeoutError,
    ApiDependencyBackoffError,
    ApiConflictError,
    ApiUnprocessableError,
    ApiPreconditionFailedError,
    ApiUnsupportedMediaTypeError,
    ApiNotImplementedError,
    ApiCodedError,
    ErrorTranslators,
    HttpResponseDto,
    HttpResponseStatus,
    WRONG_LOGIN,
} from '@webpieces/core-util';
import { ClientErrorTranslator } from '../ClientErrorTranslator';
import { UnexpectedApiResponseError } from '../UnexpectedApiResponseError';

/** A custom app error at HTTP 460 — the concrete driver (mirrors a consumer app's AiBadRequestError). */
class AiBadRequestError extends Error {
    constructor(
        message: string,
        public readonly statusCode = 460,
    ) {
        super(message);
        this.name = 'AiBadRequest';
        Object.setPrototypeOf(this, new.target.prototype);
    }
}

/** Bidirectional translators for {@link AiBadRequestError}: exception <-> the WHOLE response. */
class AiErrorTranslators implements ErrorTranslators {
    toWire(error: Error): HttpResponseDto {
        if (!(error instanceof AiBadRequestError)) {
            // "Not mine" on the server half; this spec exercises fromWire, and http-client-core has
            // no server mapper, so the shape is what matters: always a response, never undefined.
            return new HttpResponseDto(
                new HttpResponseStatus(500, 'Internal Server Error'),
                [],
                new ApiErrorPayload('implementation', 'Internal Error'),
            );
        }
        const pe = new ApiErrorPayload('bad-request', 'Bad Request');
        pe.message = error.message;
        return new HttpResponseDto(new HttpResponseStatus(460, 'AI Bad Request'), [], pe);
    }
    fromWire(response: HttpResponseDto): Error | undefined {
        if (response.status.code !== 460) {
            return undefined; // not claimed -> webpieces' built-in mapping
        }
        return new AiBadRequestError(
            (response.body as ApiErrorPayload).message ?? 'AI bad request',
        );
    }
}

/** The response DTO a client's HttpResponseDtoFactory hands the translator. */
function fakeResponse(
    status: number,
    statusText = '',
    pe: ApiErrorPayload = new ApiErrorPayload('', 'Request Failed'),
): HttpResponseDto {
    return new HttpResponseDto(new HttpResponseStatus(status, statusText), [], pe);
}

/** The error half of the translation, for the assertions that only care about the type. */
function translate(
    status: number,
    pe: ApiErrorPayload = new ApiErrorPayload('', 'Request Failed'),
    statusText = '',
): Error {
    return ClientErrorTranslator.translateError(fakeResponse(status, statusText, pe)).error;
}

/**
 * An installed ErrorTranslators is consulted for every response, so an app both ADDS custom types
 * and OVERRIDES built-ins — while a status it does not CLAIM (`undefined`) falls through to the same
 * generic mapping as before AND is marked not-app-registered, which is what the 4xx-to-500 wrap in
 * NodeProxyClient keys off. This is the CLIENT half of the wire symmetry.
 */
describe('ClientErrorTranslator registry integration', () => {
    beforeEach(() => {
        ClientRegistry.clear();
    });

    it('reconstructs an installed custom type (460) that the built-in switch cannot', () => {
        // With no translators, 460 becomes a generic ApiCodedError carrying the status.
        const generic = translate(460);
        expect(generic).not.toBeInstanceOf(AiBadRequestError);
        expect(generic).toBeInstanceOf(ApiCodedError);
        expect((generic as ApiCodedError).statusCode).toBe(460);

        ClientRegistry.setErrorTranslators(new AiErrorTranslators());

        const pe = new ApiErrorPayload();
        pe.message = 'bad ai input';
        const err = translate(460, pe);
        expect(err).toBeInstanceOf(AiBadRequestError);
        expect(err.message).toBe('bad ai input');
    });

    it('a DECLINED status is identical to registering no translator at all', () => {
        const pe = new ApiErrorPayload('bad-request', 'Bad Request');
        pe.field = 'email';
        const withNone = translate(400, pe);

        ClientRegistry.setErrorTranslators(new AiErrorTranslators()); // only claims 460
        const withTranslator = translate(400, pe);

        expect(withTranslator).toBeInstanceOf(ApiBadRequestError);
        expect(withTranslator).toEqual(withNone);
    });

    it('installed translators OVERRIDE a built-in status (400 -> custom type wins)', () => {
        const override: ErrorTranslators = {
            toWire: (error: Error) =>
                new HttpResponseDto(
                    new HttpResponseStatus(500, 'Internal Server Error'),
                    [],
                    new ApiErrorPayload('implementation', error.name),
                ),
            fromWire: (response: HttpResponseDto) =>
                response.status.code === 400
                    ? new AiBadRequestError(
                          (response.body as ApiErrorPayload).message ?? 'overridden 400',
                      )
                    : undefined,
        };
        ClientRegistry.setErrorTranslators(override);

        const err = translate(400);
        expect(err).toBeInstanceOf(AiBadRequestError);
    });

    it('an unknown 100-599 status with no translators becomes ApiCodedError with that status', () => {
        const err = translate(499, new ApiErrorPayload('', 'Request Failed'), 'weird');
        expect(err).toBeInstanceOf(ApiCodedError);
        expect((err as ApiCodedError).statusCode).toBe(499);
    });

    it('a status no HTTP response can carry stays an adapter-local UnexpectedApiResponseError', () => {
        const err = translate(600, new ApiErrorPayload('', 'Request Failed'), 'weird');
        expect(err).toBeInstanceOf(UnexpectedApiResponseError);
        expect((err as UnexpectedApiResponseError).statusCode).toBe(600);
    });

    it('non-Webpieces responders: 409/412/415/422/501 map to their named classes', () => {
        expect(translate(409)).toBeInstanceOf(ApiConflictError);
        expect(translate(412)).toBeInstanceOf(ApiPreconditionFailedError);
        expect(translate(415)).toBeInstanceOf(ApiUnsupportedMediaTypeError);
        expect(translate(422)).toBeInstanceOf(ApiUnprocessableError);
        expect(translate(501)).toBeInstanceOf(ApiNotImplementedError);
    });
});

/**
 * translateError returns a {@link TranslatedFailure}, not a bare Error, because the mapping is only
 * HALF the decision — the same isomorphic mapping runs in a browser and in a server, and only the
 * PROVENANCE tells `ProxyClient.adaptDownstreamFailure` whether the app chose this error type
 * deliberately or the framework's built-in default did. Two `ApiNotFoundError`s are identical as
 * values; they are not identical as decisions.
 */
describe('TranslatedFailure carries the provenance the environment hook needs', () => {
    beforeEach(() => {
        ClientRegistry.clear();
    });

    it('a BUILT-IN mapping reports appRegistered=false and the downstream status', () => {
        const failure = ClientErrorTranslator.translateError(fakeResponse(404));

        expect(failure.appRegistered).toBe(false);
        expect(failure.statusCode).toBe(404);
        expect(failure.error).toBeInstanceOf(ApiNotFoundError);
    });

    it('an APP translator reports appRegistered=true — the deliberate, greppable choice', () => {
        ClientRegistry.setErrorTranslators(new AiErrorTranslators());

        const failure = ClientErrorTranslator.translateError(fakeResponse(460));

        expect(failure.appRegistered).toBe(true);
        expect(failure.statusCode).toBe(460);
        expect(failure.error).toBeInstanceOf(AiBadRequestError);
    });

    it("statusCode is the DOWNSTREAM status, not the registered error's own code (relay case)", () => {
        // A gateway app deliberately relays a 404 as its own — its fromWire claims 404.
        const relay: ErrorTranslators = {
            toWire: () => undefined,
            fromWire: (response: HttpResponseDto) =>
                response.status.code === 404
                    ? new ApiNotFoundError((response.body as ApiErrorPayload).message ?? 'relayed')
                    : undefined,
        };
        ClientRegistry.setErrorTranslators(relay);

        const failure = ClientErrorTranslator.translateError(fakeResponse(404));

        expect(failure.appRegistered).toBe(true);
        expect(failure.statusCode).toBe(404);
    });
});

/**
 * The CLIENT half of the server -> wire -> client round trip.
 *
 * `http-server` does not depend on this package and must not start to for a test's convenience, so
 * the round trip is pinned as two halves that meet on the wire bytes. The fixtures below are exactly
 * what `http-server`'s `ApiErrorHttpMapper.spec.ts` ("the exact wire bytes, so the client half can
 * be pinned against them") asserts a webpieces server emits. Change one and the other stops
 * describing reality.
 *
 * What this proves is the thing the genericization had to preserve: a caller still gets the right
 * TYPE. Only the prose changed, and only for the types whose prose was never written for a caller.
 */
describe('the exact bodies a webpieces server now emits, reconstructed', () => {
    beforeEach(() => {
        ClientRegistry.clear();
    });

    /** [status, server error, class the caller must receive] */
    const wire: ReadonlyArray<readonly [number, Error, new (...args: never[]) => Error]> = [
        [400, new ApiBadRequestError('secret'), ApiBadRequestError],
        [401, new ApiUnauthorizedError('secret'), ApiUnauthorizedError],
        [403, new ApiForbiddenError('secret'), ApiForbiddenError],
        [404, new ApiNotFoundError('secret'), ApiNotFoundError],
        [408, new ApiRequestTimeoutError('secret'), ApiRequestTimeoutError],
        [429, new ApiRateLimitedError('secret'), ApiRateLimitedError],
        [500, new ApiImplementationError('secret'), ApiImplementationError],
        [502, new ApiDependencyError('secret'), ApiDependencyError],
        [503, new ApiUnavailableError('secret'), ApiUnavailableError],
        [504, new ApiDependencyTimeoutError('secret'), ApiDependencyTimeoutError],
        [503, new ApiDependencyBackoffError('secret'), ApiDependencyBackoffError],
        [409, new ApiConflictError('secret'), ApiConflictError],
        [412, new ApiPreconditionFailedError('secret'), ApiPreconditionFailedError],
        [415, new ApiUnsupportedMediaTypeError('secret'), ApiUnsupportedMediaTypeError],
        [422, new ApiUnprocessableError('secret'), ApiUnprocessableError],
        [501, new ApiNotImplementedError('secret'), ApiNotImplementedError],
        [460, new ApiCodedError('secret', 460), ApiCodedError],
    ];

    for (const [status, serverError, expectedClass] of wire) {
        it(`${status} -> ${expectedClass.name} carrying the generic message`, () => {
            const pe = ApiErrorCodec.encode(serverError);

            const err = translate(status, pe);

            expect(err).toBeInstanceOf(expectedClass);
            expect(err.message).toBe(pe.message);
        });
    }

    it('266 -> ApiEndUserError with the human-facing message and errorCode intact', () => {
        const pe = new ApiErrorPayload('end-user', 'Password must be 12+ characters');
        pe.errorCode = 'PW_SHORT';
        pe.subType = 'USER_ERROR';

        const err = translate(266, pe);

        expect(err).toBeInstanceOf(ApiEndUserError);
        expect(err.message).toBe('Password must be 12+ characters');
        expect((err as ApiEndUserError).errorCode).toBe('PW_SHORT');
    });

    it('401 keeps subType, so a caller can still branch on WHY login failed', () => {
        const pe = new ApiErrorPayload('unauthorized', 'Unauthorized');
        pe.subType = WRONG_LOGIN;

        const err = translate(401, pe);

        expect(err).toBeInstanceOf(ApiUnauthorizedError);
        expect((err as ApiUnauthorizedError).subType).toBe(WRONG_LOGIN);
    });

    it('400 keeps callerMessage and field — the human-safe half of a bad request', () => {
        const pe = new ApiErrorPayload('bad-request', 'Bad Request');
        pe.field = 'email';
        pe.callerMessage = 'Enter a valid email';

        const err = translate(400, pe);

        expect(err).toBeInstanceOf(ApiBadRequestError);
        expect((err as ApiBadRequestError).field).toBe('email');
        expect((err as ApiBadRequestError).callerMessage).toBe('Enter a valid email');
    });

    it('503 dependency backoff keeps retryAfterSeconds', () => {
        const pe = new ApiErrorPayload('dependency-backoff', 'Dependency Unavailable');
        pe.retryAfterSeconds = 45;

        const err = translate(503, pe);

        expect((err as ApiDependencyBackoffError).retryAfterSeconds).toBe(45);
    });

    it('uses semantic kind to distinguish two errors sharing HTTP 404', () => {
        const err = translate(404, new ApiErrorPayload('endpoint-not-found', 'Endpoint Not Found'));
        expect(err.name).toBe('ApiEndpointNotFoundError');
    });

    it('marks decoded implementation failures as server errors', () => {
        const err = translate(500, new ApiErrorPayload('implementation', 'Internal Error'));
        expect(err).toBeInstanceOf(ApiImplementationError);
        expect((err as ApiImplementationError).serverError).toBe(true);
    });

    it('a coded body reconstructs ApiCodedError with its unknown status and errorCode', () => {
        const pe = ApiErrorCodec.encode(new ApiCodedError('secret', 460, 'SHAPE'));

        const err = translate(460, pe);

        expect(err).toBeInstanceOf(ApiCodedError);
        expect(err).toMatchObject({ statusCode: 460, errorCode: 'SHAPE' });
        expect(err.message).not.toContain('secret');
    });

    it('a coded body whose statusCode disagrees with the HTTP status is a remote implementation failure', () => {
        const pe = ApiErrorCodec.encode(new ApiCodedError('secret', 460));

        const err = translate(461, pe);

        expect(err).toBeInstanceOf(ApiImplementationError);
    });

    it('normalizes a body kind/status mismatch to a remote implementation failure', () => {
        const err = translate(404, new ApiErrorPayload('forbidden', 'Forbidden'));
        expect(err).toBeInstanceOf(ApiImplementationError);
        expect((err as ApiImplementationError).serverError).toBe(true);
    });
});
