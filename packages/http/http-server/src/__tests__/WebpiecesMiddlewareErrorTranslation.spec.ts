import { describe, it, expect, beforeEach } from 'vitest';
import {
    ClientRegistry,
    ProtocolError,
    HttpError,
    HttpBadRequestError,
    ErrorTranslation,
    ErrorWireForm,
} from '@webpieces/core-util';
import { ExpressWrapper } from '../WebpiecesMiddleware';

/** A custom app error at HTTP 460 — the concrete driver (mirrors Mealco's HttpAiBadRequestError). */
class AiBadRequestError extends HttpError {
    constructor(message: string) {
        super(message, 460);
        this.name = 'AiBadRequest';
        Object.setPrototypeOf(this, new.target.prototype);
    }
}

/** Bidirectional translation for {@link AiBadRequestError}: exception <-> wire (statusCode 460). */
class AiErrorTranslation implements ErrorTranslation {
    toWire(error: Error): ErrorWireForm | undefined {
        if (!(error instanceof AiBadRequestError)) {
            return undefined;
        }
        const pe = new ProtocolError();
        pe.message = error.message;
        pe.name = error.name;
        return new ErrorWireForm(460, pe);
    }
    fromWire(statusCode: number, pe: ProtocolError): Error | undefined {
        if (statusCode !== 460) {
            return undefined;
        }
        return new AiBadRequestError(pe.message ?? 'AI bad request');
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
 * ExpressWrapper.handleError consults ClientRegistry.tryTranslateToWire() BEFORE its built-in
 * instanceof-HttpError ladder, so an app both ADDS custom types and OVERRIDES built-ins — while
 * unregistered errors fall through to the exact same generic mapping as before. SERVER half of the
 * wire symmetry with ClientErrorTranslator (the round-trip itself is proven in core-util's
 * ClientRegistry.spec.ts, using the same AiErrorTranslation both directions).
 */
describe('ExpressWrapper.handleError registry integration', () => {
    beforeEach(() => {
        ClientRegistry.clear();
    });

    it('serializes a registered custom type (460) the built-in ladder cannot', () => {
        ClientRegistry.addErrorTranslation(new AiErrorTranslation());

        const res = new FakeResponse();
        newWrapper().handleError(asResponse(res), new AiBadRequestError('bad ai input'));

        expect(res.statusCode).toBe(460);
        expect(res.getHeader('content-type')).toBe('application/json');
        const pe = JSON.parse(res.body ?? '{}') as ProtocolError;
        expect(pe.message).toBe('bad ai input');
        expect(pe.name).toBe('AiBadRequest');
    });

    it('an unregistered error still uses the built-in ladder (HttpBadRequestError -> 400)', () => {
        ClientRegistry.addErrorTranslation(new AiErrorTranslation()); // only claims AiBadRequestError

        const res = new FakeResponse();
        newWrapper().handleError(asResponse(res), new HttpBadRequestError('bad field', 'email'));

        expect(res.statusCode).toBe(400);
        const pe = JSON.parse(res.body ?? '{}') as ProtocolError;
        expect(pe.field).toBe('email');
    });

    it('does nothing once headers are already sent', () => {
        ClientRegistry.addErrorTranslation(new AiErrorTranslation());

        const res = new FakeResponse();
        res.headersSent = true;
        newWrapper().handleError(asResponse(res), new AiBadRequestError('too late'));

        expect(res.statusCode).toBeUndefined();
        expect(res.body).toBeUndefined();
    });
});
