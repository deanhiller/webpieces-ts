import { describe, it, expect, beforeEach } from 'vitest';
import {
    ClientRegistry,
    ProtocolError,
    HttpError,
    HttpBadRequestError,
    ErrorTranslators,
    HttpHeader,
    HttpResponseDto,
    HttpResponseStatus,
    WebpiecesCoreHeaders,
} from '@webpieces/core-util';
import { RequestContext } from '@webpieces/core-context';
import { ExpressWrapper } from '../ExpressWrapper';

/** A custom app error at HTTP 460 — the concrete driver (mirrors a consumer app's HttpAiBadRequestError). */
class AiBadRequestError extends HttpError {
    constructor(message: string) {
        super(message, 460);
        this.name = 'AiBadRequest';
        Object.setPrototypeOf(this, new.target.prototype);
    }
}

/** Bidirectional translation for {@link AiBadRequestError}: exception <-> wire (statusCode 460). */
class AiErrorTranslators implements ErrorTranslators {
    toWire(error: Error): HttpResponseDto | undefined {
        if (!(error instanceof AiBadRequestError)) {
            return undefined;
        }
        const pe = new ProtocolError();
        pe.message = error.message;
        pe.name = error.name;
        return new HttpResponseDto(
            new HttpResponseStatus(460, 'AI Bad Request'),
            [new HttpHeader('x-ai-error', 'true')],
            pe,
        );
    }
    fromWire(response: HttpResponseDto): Error | undefined {
        if (response.status.code !== 460) {
            return undefined;
        }
        const pe = response.body as ProtocolError;
        return new AiBadRequestError(pe.message ?? 'AI bad request');
    }
}

/** Captures what handleError writes: status code, headers, and the serialized body. */
class FakeResponse {
    public statusCode?: number;
    public body?: string;
    public headersSent = false;
    public statusMessage?: string;
    private readonly headers = new Map<string, string | readonly string[]>();

    status(code: number): this {
        this.statusCode = code;
        return this;
    }
    setHeader(name: string, value: string | readonly string[]): this {
        this.headers.set(name.toLowerCase(), value);
        return this;
    }
    send(payload: string): this {
        this.body = payload;
        this.headersSent = true;
        return this;
    }
    getHeader(name: string): string | readonly string[] | undefined {
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
        { fillFromRequest() {} } as unknown as ConstructorParameters<typeof ExpressWrapper>[2],
    );
}

/**
 * ExpressWrapper.handleError consults ClientRegistry.tryTranslateToWire() BEFORE its built-in
 * instanceof-HttpError ladder, so an app both ADDS custom types and OVERRIDES built-ins — while
 * unregistered errors fall through to the exact same generic mapping as before. SERVER half of the
 * wire symmetry with ClientErrorTranslator (the round-trip itself is proven in core-util's
 * ClientRegistry.spec.ts, using the same AiErrorTranslators both directions).
 */
describe('ExpressWrapper.handleError registry integration', () => {
    beforeEach(() => {
        ClientRegistry.clear();
    });

    it('serializes a registered custom type (460) the built-in ladder cannot, VERBATIM', () => {
        ClientRegistry.setErrorTranslators(new AiErrorTranslators());

        const res = new FakeResponse();
        newWrapper().handleError(asResponse(res), new AiBadRequestError('bad ai input'));

        expect(res.statusCode).toBe(460);
        expect(res.statusMessage).toBe('AI Bad Request');
        expect(res.getHeader('x-ai-error')).toBe('true');
        expect(res.getHeader('content-type')).toBe('application/json');
        const pe = JSON.parse(res.body ?? '{}') as ProtocolError;
        // The registry is the explicit opt-out from HttpErrorWireMapper's genericization: the app
        // authored this body, so message AND name are published exactly as toWire() returned them.
        expect(pe.message).toBe('bad ai input');
        expect(pe.name).toBe('AiBadRequest');
    });

    it('an unregistered error still uses the built-in ladder (HttpBadRequestError -> 400)', () => {
        ClientRegistry.setErrorTranslators(new AiErrorTranslators()); // only claims AiBadRequestError

        const res = new FakeResponse();
        newWrapper().handleError(asResponse(res), new HttpBadRequestError('bad field', 'email'));

        expect(res.statusCode).toBe(400);
        const pe = JSON.parse(res.body ?? '{}') as ProtocolError;
        expect(pe.field).toBe('email');
        // ...and the built-in ladder genericizes, unlike the registry path above.
        expect(pe.message).toBe('Bad Request');
        expect(pe.name).toBeUndefined();
    });

    it('preserves repeated response headers', () => {
        ClientRegistry.setErrorTranslators({
            toWire: () =>
                new HttpResponseDto(
                    new HttpResponseStatus(460, 'Cookies Required'),
                    [new HttpHeader('Set-Cookie', 'a=1'), new HttpHeader('Set-Cookie', 'b=2')],
                    new ProtocolError(),
                ),
            fromWire: () => undefined,
        });

        const res = new FakeResponse();
        newWrapper().handleError(asResponse(res), new AiBadRequestError('cookies'));

        expect(res.getHeader('set-cookie')).toEqual(['a=1', 'b=2']);
    });

    it('does nothing once headers are already sent', () => {
        ClientRegistry.setErrorTranslators(new AiErrorTranslators());

        const res = new FakeResponse();
        res.headersSent = true;
        newWrapper().handleError(asResponse(res), new AiBadRequestError('too late'));

        expect(res.statusCode).toBeUndefined();
        expect(res.body).toBeUndefined();
    });

    it('emits the infrastructure request id on default 200 and 500 responses', async () => {
        await RequestContext.run(async () => {
            RequestContext.putUntrusted(WebpiecesCoreHeaders.REQUEST_ID, 'request-862');

            const success = new FakeResponse();
            const request = { method: 'GET', headers: {} } as import('express').Request;
            await newWrapper().executeImpl(request, asResponse(success), () => {});
            expect(success.getHeader('x-request-id')).toBe('request-862');

            const failure = new FakeResponse();
            newWrapper().handleError(asResponse(failure), new Error('boom'));
            expect(failure.getHeader('x-request-id')).toBe('request-862');
        });
    });
});
