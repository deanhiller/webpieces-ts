import { describe, it, expect, beforeEach } from 'vitest';
import {
    ClientRegistry,
    ApiErrorPayload,
    ApiBadRequestError,
    ErrorTranslators,
    HttpHeader,
    HttpResponseDto,
    HttpResponseStatus,
} from '@webpieces/core-util';
import { ExpressWrapper } from '../ExpressWrapper';
import { ApiErrorHttpMapper } from '../ApiErrorHttpMapper';

/** A custom app error at HTTP 460 — the concrete driver (mirrors a consumer app's AiBadRequestError). */
class AiBadRequestError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'AiBadRequest';
        Object.setPrototypeOf(this, new.target.prototype);
    }
}

class AiErrorPayload {
    constructor(
        public message: string,
        public name: string,
    ) {}
}

/** Bidirectional translators for {@link AiBadRequestError}: exception <-> the WHOLE response. */
class AiErrorTranslators implements ErrorTranslators {
    /** "Not mine" is a DELEGATION to the webpieces default now, never an `undefined`. */
    private readonly fallback = new ApiErrorHttpMapper('gui');

    toWire(error: Error): HttpResponseDto {
        if (!(error instanceof AiBadRequestError)) {
            return this.fallback.toResponse(error);
        }
        const pe = new AiErrorPayload(error.message, error.name);
        return new HttpResponseDto(new HttpResponseStatus(460, 'AI Bad Request'), [], pe);
    }
    fromWire(response: HttpResponseDto): Error | undefined {
        if (response.status.code !== 460) {
            return undefined;
        }
        return new AiBadRequestError((response.body as AiErrorPayload).message ?? 'AI bad request');
    }
}

/** Captures what handleError writes: status code, headers, and the serialized body. */
class FakeResponse {
    public statusCode?: number;
    public body?: string;
    public headersSent = false;
    private readonly headers = new Map<string, string>();

    status(code: number): this {
        this.statusCode = code;
        return this;
    }
    setHeader(name: string, value: string): this {
        this.headers.set(name.toLowerCase(), value);
        return this;
    }
    append(name: string, value: string): this {
        return this.setHeader(name, value);
    }
    send(payload: string): this {
        this.body = payload;
        this.headersSent = true;
        return this;
    }
    getHeader(name: string): string | undefined {
        return this.headers.get(name.toLowerCase());
    }
}

// webpieces-disable no-any-unknown -- test double: handleError only touches status/setHeader/send/headersSent
function asResponse(fake: FakeResponse): import('express').Response {
    return fake as unknown as import('express').Response;
}

/** ExpressWrapper never needs its ctor args for handleError; a bare instance suffices. */
function newWrapper(): ExpressWrapper {
    return new ExpressWrapper(
        () => Promise.resolve({}),
        '/test',
        // webpieces-disable no-any-unknown -- RequestContextHeaders is unused by handleError
        {} as unknown as ConstructorParameters<typeof ExpressWrapper>[2],
    );
}

/**
 * A registered ErrorTranslators REPLACES the webpieces default in ExpressWrapper.handleError, so an
 * app both ADDS custom types and OVERRIDES built-ins — while an error it declines is handed to
 * `ApiErrorHttpMapper` by the app itself and comes out byte-identical to registering nothing. SERVER half of the wire symmetry with
 * ClientErrorTranslator (the round-trip itself is proven in core-util's ClientRegistry.spec.ts,
 * using the same AiErrorTranslators both directions).
 */
describe('ExpressWrapper.handleError registry integration', () => {
    beforeEach(() => {
        ClientRegistry.clear();
    });

    it('serializes an installed custom type (460) the built-in ladder cannot, VERBATIM', () => {
        ClientRegistry.setErrorTranslators(new AiErrorTranslators());

        const res = new FakeResponse();
        newWrapper().handleError(asResponse(res), new AiBadRequestError('bad ai input'));

        expect(res.statusCode).toBe(460);
        expect(res.getHeader('content-type')).toBe('application/json');
        const pe = JSON.parse(res.body ?? '{}') as AiErrorPayload;
        // The translators are the explicit opt-out from ApiErrorHttpMapper's genericization: the app
        // authored this body, so message AND name are published exactly as toWire() returned them.
        expect(pe.message).toBe('bad ai input');
        expect(pe.name).toBe('AiBadRequest');
    });

    it('a DECLINED error is byte-identical to registering no translator at all', () => {
        const declined = new ApiBadRequestError('bad field', 'email');

        const withNone = new FakeResponse();
        newWrapper().handleError(asResponse(withNone), declined);

        ClientRegistry.setErrorTranslators(new AiErrorTranslators()); // only claims AiBadRequestError
        const withTranslator = new FakeResponse();
        newWrapper().handleError(asResponse(withTranslator), declined);

        expect(withTranslator.statusCode).toBe(400);
        expect(withNone.statusCode).toBe(400);
        expect(withTranslator.body).toBe(withNone.body);
        const pe = JSON.parse(withTranslator.body ?? '{}') as ApiErrorPayload;
        expect(pe.field).toBe('email');
        // ...and the built-in ladder genericizes, unlike the app path above.
        expect(pe.message).toBe('Bad Request');
        expect(pe).not.toHaveProperty('name');
    });

    it('does nothing once headers are already sent', () => {
        ClientRegistry.setErrorTranslators(new AiErrorTranslators());

        const res = new FakeResponse();
        res.headersSent = true;
        newWrapper().handleError(asResponse(res), new AiBadRequestError('too late'));

        expect(res.statusCode).toBeUndefined();
        expect(res.body).toBeUndefined();
    });
});
