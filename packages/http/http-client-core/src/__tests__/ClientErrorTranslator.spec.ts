import { describe, it, expect, beforeEach } from 'vitest';
import {
    ApiDependencyError,
    ApiEndUserError,
    ApiErrorPayload,
    ApiImplementationError,
    ClientRegistry,
    ErrorTranslator,
    HttpResponseDto,
    HttpResponseStatus,
    toError,
    WebpiecesDefaultErrorTranslator,
} from '@webpieces/core-util';
import { ClientErrorTranslator } from '../ClientErrorTranslator';

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

/** Bidirectional translator for {@link AiBadRequestError}: exception <-> the WHOLE response. */
class AiErrorTranslator implements ErrorTranslator {
    private readonly fallback = new WebpiecesDefaultErrorTranslator();

    toWire(error: Error): HttpResponseDto {
        if (!(error instanceof AiBadRequestError)) {
            return this.fallback.toWire(error);
        }
        const pe = new ApiErrorPayload('bad-request', 'Bad Request');
        pe.message = error.message;
        return new HttpResponseDto(new HttpResponseStatus(460, 'AI Bad Request'), [], pe);
    }

    fromWire(response: HttpResponseDto): void {
        if (response.status.code !== 460) {
            this.fallback.fromWire(response); // not mine -> the webpieces default answers
            return;
        }
        throw new AiBadRequestError((response.body as ApiErrorPayload).message ?? 'AI bad request');
    }
}

/**
 * A translator with a BUG: it returns for a failure response instead of throwing. The framework must
 * not hand `undefined` to a typed caller because an app got this wrong.
 */
class SilentTranslator implements ErrorTranslator {
    toWire(error: Error): HttpResponseDto {
        return new WebpiecesDefaultErrorTranslator().toWire(error);
    }
    fromWire(): void {
        // deliberately returns for EVERY response, failures included
    }
}

/** The response DTO a client's HttpResponseDtoFactory hands the translator. */
const fakeResponse = (
    status: number,
    body: unknown = new ApiErrorPayload('', 'Request Failed'),
    statusText = '',
): HttpResponseDto => new HttpResponseDto(new HttpResponseStatus(status, statusText), [], body);

const catchOf = (run: () => void): Error => {
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- this helper IS the catch
    try {
        run();
    } catch (err: unknown) {
        const error = toError(err);
        return error;
    }
    throw new Error('expected a throw, got a normal return');
};

/**
 * The CLIENT half of the wire seam. There is no "was a translator registered" question any more, and
 * no `TranslatedFailure` provenance record: provenance existed only to feed the deleted
 * `ProxyClient.adaptDownstreamFailure`, and the uniform 4xx/5xx rule replaced that hook. An app that
 * wants a downstream status relayed as its own type now says so by THROWING it from `fromWire`.
 */
describe('ClientErrorTranslator', () => {
    beforeEach(() => {
        ClientRegistry.resetForTests();
    });

    it('with nothing registered, applies the webpieces default: 4xx is MY bug', () => {
        expect(() => ClientErrorTranslator.throwIfFailure(fakeResponse(404))).toThrow(
            ApiImplementationError,
        );
    });

    it('with nothing registered, 5xx is the PEER bug, not ours', () => {
        expect(() => ClientErrorTranslator.throwIfFailure(fakeResponse(503))).toThrow(
            ApiDependencyError,
        );
    });

    it('an ordinary 2xx passes straight through — every response reaches the seam, not just failures', () => {
        expect(() =>
            ClientErrorTranslator.throwIfFailure(fakeResponse(200, { ok: true })),
        ).not.toThrow();
    });

    it('a registered translator reconstructs a custom type (460) the default cannot', () => {
        ClientRegistry.setErrorTranslator(new AiErrorTranslator());
        const pe = new ApiErrorPayload('bad-request', 'Bad Request');
        pe.message = 'bad ai input';

        expect(() => ClientErrorTranslator.throwIfFailure(fakeResponse(460, pe))).toThrow(
            AiBadRequestError,
        );
    });

    it('a status the app does not claim DELEGATES to the default, not to a sentinel', () => {
        ClientRegistry.setErrorTranslator(new AiErrorTranslator()); // only claims 460

        expect(() => ClientErrorTranslator.throwIfFailure(fakeResponse(403))).toThrow(
            ApiImplementationError,
        );
    });

    it('registering a translator that only delegates is identical to registering nothing', () => {
        const withNothing = catchOf(() => ClientErrorTranslator.throwIfFailure(fakeResponse(500)));

        ClientRegistry.setErrorTranslator(new WebpiecesDefaultErrorTranslator());
        const withDelegating = catchOf(() =>
            ClientErrorTranslator.throwIfFailure(fakeResponse(500)),
        );

        expect(withDelegating.constructor).toBe(withNothing.constructor);
        expect(withDelegating.message).toBe(withNothing.message);
    });

    it('an app translator can turn a 200 into a throw', () => {
        class PaymentDeclined extends Error {}
        ClientRegistry.setErrorTranslator({
            toWire: (error: Error) => new WebpiecesDefaultErrorTranslator().toWire(error),
            fromWire: (dto: HttpResponseDto) => {
                const body = dto.body as { status?: string } | undefined;
                if (body?.status === 'DECLINED') throw new PaymentDeclined('card declined');
                new WebpiecesDefaultErrorTranslator().fromWire(dto);
            },
        });

        expect(() =>
            ClientErrorTranslator.throwIfFailure(fakeResponse(200, { status: 'DECLINED' })),
        ).toThrow(PaymentDeclined);
    });

    it('266 keeps its typed ApiEndUserError and its verbatim message', () => {
        const wire = new WebpiecesDefaultErrorTranslator().toWire(
            new ApiEndUserError('say it again'),
        );

        const error = catchOf(() => ClientErrorTranslator.throwIfFailure(wire));
        expect(error).toBeInstanceOf(ApiEndUserError);
        expect(error.message).toBe('say it again');
    });

    /**
     * THE invariant `ProxyClient.readResponse` relies on: a failure response can NEVER return
     * normally, even when the registered translator forgets to throw. The webpieces default runs
     * behind it — bug containment, not a "was one registered" branch.
     */
    describe('a non-2xx can never return normally', () => {
        it('an app translator that silently returns is backstopped by the webpieces default', () => {
            ClientRegistry.setErrorTranslator(new SilentTranslator());

            expect(() => ClientErrorTranslator.throwIfFailure(fakeResponse(404))).toThrow(
                ApiImplementationError,
            );
            expect(() => ClientErrorTranslator.throwIfFailure(fakeResponse(500))).toThrow(
                ApiDependencyError,
            );
        });

        it('throwFailure is typed never, and is a loud framework bug if handed a plain 2xx', () => {
            expect(() =>
                ClientErrorTranslator.throwFailure(fakeResponse(200, { ok: true })),
            ).toThrow(/ordinary success/);
        });
    });
});
