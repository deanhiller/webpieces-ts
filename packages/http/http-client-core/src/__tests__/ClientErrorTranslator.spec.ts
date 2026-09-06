import { describe, it, expect, beforeEach } from 'vitest';
import {
    ClientRegistry,
    ProtocolError,
    HttpError,
    HttpBadRequestError,
    HttpNotFoundError,
    HttpUserError,
    HttpUnauthorizedError,
    HttpForbiddenError,
    HttpTimeoutError,
    HttpTooManyRequestsError,
    HttpInternalServerError,
    HttpBadGatewayError,
    HttpServiceUnavailableError,
    HttpGatewayTimeoutError,
    HttpVendorError,
    ErrorTranslators,
    HttpResponseDto,
    HttpResponseStatus,
    WRONG_LOGIN,
} from '@webpieces/core-util';
import { ClientErrorTranslator } from '../ClientErrorTranslator';

/** A custom app error at HTTP 460 — the concrete driver (mirrors a consumer app's HttpAiBadRequestError). */
class AiBadRequestError extends HttpError {
    constructor(message: string) {
        super(message, 460);
        this.name = 'AiBadRequest';
        Object.setPrototypeOf(this, new.target.prototype);
    }
}

/** Bidirectional translators for {@link AiBadRequestError}: exception <-> the WHOLE response. */
class AiErrorTranslators implements ErrorTranslators {
    toWire(error: Error): HttpResponseDto | undefined {
        if (!(error instanceof AiBadRequestError)) {
            return undefined;
        }
        const pe = new ProtocolError();
        pe.message = error.message;
        pe.name = error.name;
        return new HttpResponseDto(new HttpResponseStatus(460, 'AI Bad Request'), [], pe);
    }
    fromWire(response: HttpResponseDto): Error | undefined {
        if (response.status.code !== 460) {
            return undefined;
        }
        return new AiBadRequestError((response.body as ProtocolError).message ?? 'AI bad request');
    }
}

/** The response DTO a client's HttpResponseDtoFactory hands the translator. */
function fakeResponse(status: number, statusText = '', pe: ProtocolError = new ProtocolError()): HttpResponseDto {
    return new HttpResponseDto(new HttpResponseStatus(status, statusText), [], pe);
}

/** The error half of the translation, for the assertions that only care about the type. */
function translate(status: number, pe: ProtocolError = new ProtocolError(), statusText = ''): Error {
    return ClientErrorTranslator.translateError(fakeResponse(status, statusText, pe)).error;
}

/**
 * ClientErrorTranslator consults ClientRegistry.tryTranslateFromWire() BEFORE its built-in switch,
 * so an app both ADDS custom types and OVERRIDES built-ins — while unclaimed codes fall through to
 * the exact same generic mapping as before. This is the CLIENT half of the wire symmetry.
 */
describe('ClientErrorTranslator registry integration', () => {
    beforeEach(() => {
        ClientRegistry.clear();
    });

    it('reconstructs an installed custom type (460) that the built-in switch cannot', () => {
        // With no translators, 460 hits the default branch (a generic HttpError, not the app type).
        const generic = translate(460);
        expect(generic).not.toBeInstanceOf(AiBadRequestError);
        expect(generic).toBeInstanceOf(HttpError);

        ClientRegistry.setErrorTranslators(new AiErrorTranslators());

        const pe = new ProtocolError();
        pe.message = 'bad ai input';
        const err = translate(460, pe);
        expect(err).toBeInstanceOf(AiBadRequestError);
        expect(err.message).toBe('bad ai input');
    });

    it('an unclaimed status still uses the built-in mapping (400 -> HttpBadRequestError)', () => {
        ClientRegistry.setErrorTranslators(new AiErrorTranslators()); // only claims 460

        const pe = new ProtocolError();
        pe.message = 'bad field';
        pe.field = 'email';
        const err = translate(400, pe);
        expect(err).toBeInstanceOf(HttpBadRequestError);
    });

    it('installed translators OVERRIDE a built-in status (400 -> custom type wins)', () => {
        const override: ErrorTranslators = {
            toWire: () => undefined,
            fromWire: (response: HttpResponseDto) =>
                response.status.code === 400
                    ? new AiBadRequestError((response.body as ProtocolError).message ?? 'overridden 400')
                    : undefined,
        };
        ClientRegistry.setErrorTranslators(override);

        const err = translate(400);
        expect(err).toBeInstanceOf(AiBadRequestError);
    });

    it('an unknown status with no translators is a real HttpError carrying the status code', () => {
        const err = translate(499, new ProtocolError(), 'weird');
        expect(err).toBeInstanceOf(HttpError);
        expect((err as HttpError).code).toBe(499);
    });
});

/**
 * translateError returns a {@link TranslatedFailure}, not a bare Error, because the mapping is only
 * HALF the decision — the same isomorphic mapping runs in a browser and in a server, and only the
 * PROVENANCE tells `ProxyClient.adaptDownstreamFailure` whether the app chose this error type
 * deliberately or the framework's built-in default did. Two `HttpNotFoundError`s are identical as
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
        expect(failure.error).toBeInstanceOf(HttpNotFoundError);
    });

    it('an APP translator reports appRegistered=true — the deliberate, greppable choice', () => {
        ClientRegistry.setErrorTranslators(new AiErrorTranslators());

        const failure = ClientErrorTranslator.translateError(fakeResponse(460));

        expect(failure.appRegistered).toBe(true);
        expect(failure.statusCode).toBe(460);
        expect(failure.error).toBeInstanceOf(AiBadRequestError);
    });

    it('statusCode is the DOWNSTREAM status, not the registered error\'s own code (relay case)', () => {
        // A gateway app deliberately relays a 404 as its own — its fromWire claims 404.
        const relay: ErrorTranslators = {
            toWire: () => undefined,
            fromWire: (response: HttpResponseDto) =>
                response.status.code === 404
                    ? new HttpNotFoundError((response.body as ProtocolError).message ?? 'relayed')
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
 * what `http-server`'s `HttpErrorWireMapper.spec.ts` ("the exact wire bytes, so the client half can
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

    /** [status, the generic message the server sends, the class the caller must receive] */
    const wire: ReadonlyArray<readonly [number, string, new (...args: never[]) => Error]> = [
        [400, 'Bad Request', HttpBadRequestError],
        [401, 'Unauthorized', HttpUnauthorizedError],
        [403, 'Forbidden', HttpForbiddenError],
        [404, 'Not Found', HttpNotFoundError],
        [408, 'Request Timeout', HttpTimeoutError],
        [429, 'Too Many Requests', HttpTooManyRequestsError],
        [500, 'Internal Server Error', HttpInternalServerError],
        [502, 'Bad Gateway', HttpBadGatewayError],
        [503, 'Service Unavailable', HttpServiceUnavailableError],
        [504, 'Gateway Timeout', HttpGatewayTimeoutError],
        [598, 'Vendor Error', HttpVendorError],
    ];

    for (const [status, generic, expectedClass] of wire) {
        it(`${status} -> ${expectedClass.name} carrying the generic message`, () => {
            const pe = new ProtocolError();
            pe.message = generic;

            const err = translate(status, pe);

            expect(err).toBeInstanceOf(expectedClass);
            expect(err.message).toBe(generic);
        });
    }

    it('266 -> HttpUserError with the human-facing message and errorCode intact', () => {
        const pe = new ProtocolError();
        pe.message = 'Password must be 12+ characters';
        pe.errorCode = 'PW_SHORT';
        pe.subType = 'USER_ERROR';

        const err = translate(266, pe);

        expect(err).toBeInstanceOf(HttpUserError);
        expect(err.message).toBe('Password must be 12+ characters');
        expect((err as HttpUserError).errorCode).toBe('PW_SHORT');
    });

    it('401 keeps subType, so a caller can still branch on WHY login failed', () => {
        const pe = new ProtocolError();
        pe.message = 'Unauthorized';
        pe.subType = WRONG_LOGIN;

        const err = translate(401, pe);

        expect(err).toBeInstanceOf(HttpUnauthorizedError);
        expect((err as HttpUnauthorizedError).subType).toBe(WRONG_LOGIN);
    });

    it('400 keeps guiAlertMessage and field — the human-safe half of a bad request', () => {
        const pe = new ProtocolError();
        pe.message = 'Bad Request';
        pe.field = 'email';
        pe.guiAlertMessage = 'Enter a valid email';

        const err = translate(400, pe);

        expect(err).toBeInstanceOf(HttpBadRequestError);
        expect((err as HttpBadRequestError).field).toBe('email');
        expect((err as HttpBadRequestError).guiMessage).toBe('Enter a valid email');
    });

    it('598 keeps waitSeconds', () => {
        const pe = new ProtocolError();
        pe.message = 'Vendor Error';
        pe.waitSeconds = 45;

        const err = translate(598, pe);

        expect((err as HttpVendorError).waitSeconds).toBe(45);
    });
});
