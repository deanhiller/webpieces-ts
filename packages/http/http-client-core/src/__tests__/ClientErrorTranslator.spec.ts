import { describe, it, expect, beforeEach } from 'vitest';
import {
    ClientRegistry,
    ProtocolError,
    HttpError,
    HttpBadRequestError,
    HttpNotFoundError,
    ErrorTranslation,
    ErrorWireForm,
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

/** Minimal fetch-Response stand-in — translateError only reads status + statusText. */
function fakeResponse(status: number, statusText = ''): Response {
    // webpieces-disable no-any-unknown -- test double: translateError only touches status/statusText
    return { status, statusText } as unknown as Response;
}

/** The error half of the translation, for the assertions that only care about the type. */
function translate(status: number, pe: ProtocolError = new ProtocolError(), statusText = ''): Error {
    return ClientErrorTranslator.translateError(fakeResponse(status, statusText), pe).error;
}

/**
 * ClientErrorTranslator consults ClientRegistry.tryTranslateFromWire() BEFORE its built-in switch,
 * so an app both ADDS custom types and OVERRIDES built-ins — while unregistered codes fall through
 * to the exact same generic mapping as before. This is the CLIENT half of the wire symmetry.
 */
describe('ClientErrorTranslator registry integration', () => {
    beforeEach(() => {
        ClientRegistry.clear();
    });

    it('reconstructs a registered custom type (460) that the built-in switch cannot', () => {
        // Without a translation, 460 hits the default branch (a generic HttpError, not the app type).
        const generic = translate(460);
        expect(generic).not.toBeInstanceOf(AiBadRequestError);
        expect(generic).toBeInstanceOf(HttpError);

        ClientRegistry.addErrorTranslation(new AiErrorTranslation());

        const pe = new ProtocolError();
        pe.message = 'bad ai input';
        const err = translate(460, pe);
        expect(err).toBeInstanceOf(AiBadRequestError);
        expect(err.message).toBe('bad ai input');
    });

    it('an unregistered status still uses the built-in mapping (400 -> HttpBadRequestError)', () => {
        ClientRegistry.addErrorTranslation(new AiErrorTranslation()); // only claims 460

        const pe = new ProtocolError();
        pe.message = 'bad field';
        pe.field = 'email';
        const err = translate(400, pe);
        expect(err).toBeInstanceOf(HttpBadRequestError);
    });

    it('a registered translation OVERRIDES a built-in status (400 -> custom type wins)', () => {
        const override: ErrorTranslation = {
            toWire: () => undefined,
            fromWire: (statusCode: number, pe: ProtocolError) =>
                statusCode === 400 ? new AiBadRequestError(pe.message ?? 'overridden 400') : undefined,
        };
        ClientRegistry.addErrorTranslation(override);

        const err = translate(400);
        expect(err).toBeInstanceOf(AiBadRequestError);
    });

    it('an unknown status with no translation is a real HttpError carrying the status code', () => {
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
        const failure = ClientErrorTranslator.translateError(fakeResponse(404), new ProtocolError());

        expect(failure.appRegistered).toBe(false);
        expect(failure.statusCode).toBe(404);
        expect(failure.error).toBeInstanceOf(HttpNotFoundError);
    });

    it('an APP-registered translation reports appRegistered=true — the deliberate, greppable choice', () => {
        ClientRegistry.addErrorTranslation(new AiErrorTranslation());

        const failure = ClientErrorTranslator.translateError(fakeResponse(460), new ProtocolError());

        expect(failure.appRegistered).toBe(true);
        expect(failure.statusCode).toBe(460);
        expect(failure.error).toBeInstanceOf(AiBadRequestError);
    });

    it('statusCode is the DOWNSTREAM status, not the registered error\'s own code', () => {
        // A gateway app deliberately relays a 404 as its own — its translation claims 404.
        const relay: ErrorTranslation = {
            toWire: () => undefined,
            fromWire: (statusCode: number, pe: ProtocolError) =>
                statusCode === 404 ? new HttpNotFoundError(pe.message ?? 'relayed') : undefined,
        };
        ClientRegistry.addErrorTranslation(relay);

        const failure = ClientErrorTranslator.translateError(fakeResponse(404), new ProtocolError());

        expect(failure.appRegistered).toBe(true);
        expect(failure.statusCode).toBe(404);
    });
});
