import { describe, it, expect, beforeEach } from 'vitest';
import { ClientRegistry } from '../ClientRegistry';
import { ErrorTranslators } from '../ErrorTranslators';
import { HttpHeader, HttpResponseDto, HttpResponseStatus } from '../HttpResponseDto';
import { FailureClassifier } from '../FailureClassifier';
import { ApiMethodInfo } from '../ApiMethodInfo';
import { ApiErrorPayload, ApiNotFoundError, ApiBadRequestError } from '../../errors';

describe('ClientRegistry', () => {
    beforeEach(() => {
        // The registry is a process-global; reset it so specs do not leak into one another.
        ClientRegistry.clear();
    });

    it('addMapping stores http://localhost:<port>', () => {
        ClientRegistry.addMapping('server2', 8202);
        expect(ClientRegistry.lookup('server2')).toBe('http://localhost:8202');
    });

    it('addUrlMapping stores the url verbatim', () => {
        ClientRegistry.addUrlMapping('email-svc', 'https://email.example:9000/base');
        expect(ClientRegistry.lookup('email-svc')).toBe('https://email.example:9000/base');
    });

    it('a later mapping for the same svcName wins', () => {
        ClientRegistry.addMapping('server2', 8202);
        ClientRegistry.addUrlMapping('server2', 'http://localhost:18202');
        expect(ClientRegistry.lookup('server2')).toBe('http://localhost:18202');
    });

    it('tryLookup returns undefined for an unmapped service (non-throwing)', () => {
        expect(ClientRegistry.tryLookup('missing')).toBeUndefined();
        ClientRegistry.addMapping('server2', 8202);
        expect(ClientRegistry.tryLookup('server2')).toBe('http://localhost:8202');
    });

    it('lookup of an unmapped service throws, naming the service and the remedy', () => {
        expect(() => ClientRegistry.lookup('missing')).toThrow(
            /No URL registered for service "missing"\..*addMapping\(svcName, port\).*addUrlMapping\(svcName, url\)/s,
        );
    });

    it('clear() empties the registry', () => {
        ClientRegistry.addMapping('server2', 8202);
        ClientRegistry.clear();
        expect(ClientRegistry.tryLookup('server2')).toBeUndefined();
    });
});

/**
 * The ONE precedence chain every client runs: mapping, else deriver, else the caller's fallback
 * (browser -> relative, node -> throw).
 */
describe('ClientRegistry resolution chain', () => {
    beforeEach(() => {
        ClientRegistry.clear();
    });

    it('a mapping WINS over the deriver', async () => {
        ClientRegistry.addMapping('helper-fsdb', 8401);
        ClientRegistry.setDeriver((svc: string) =>
            Promise.resolve(`https://${svc}.derived.example`),
        );

        expect(await ClientRegistry.resolve('helper-fsdb')).toBe('http://localhost:8401');
    });

    it('derives when there is no mapping', async () => {
        ClientRegistry.setDeriver((svc: string) =>
            Promise.resolve(`https://${svc}.derived.example`),
        );

        expect(await ClientRegistry.resolve('helper-fsdb')).toBe(
            'https://helper-fsdb.derived.example',
        );
    });

    it('an EMPTY-STRING mapping is a legal answer (same-origin) and does NOT fall through to the deriver', async () => {
        // The truthiness bug this guards: `if (override)` would skip '' and derive instead.
        ClientRegistry.addUrlMapping('helper-portal', '');
        ClientRegistry.setDeriver((svc: string) =>
            Promise.resolve(`https://${svc}.derived.example`),
        );

        expect(await ClientRegistry.resolve('helper-portal')).toBe('');
        expect(await ClientRegistry.tryResolve('helper-portal')).toBe('');
    });

    it('tryResolve yields undefined with no mapping and no deriver — the browser reads this as relative', async () => {
        expect(await ClientRegistry.tryResolve('helper-fsdb')).toBeUndefined();
    });

    it('resolve() THROWS with no mapping and no deriver, naming every fix', async () => {
        // Node has no "own origin" to fall back to, so an unresolvable peer must fail loudly.
        await expect(ClientRegistry.resolve('helper-fsdb')).rejects.toThrow(
            /No URL for service "helper-fsdb"[\s\S]*addMapping\('helper-fsdb', 8401\)[\s\S]*addUrlMapping[\s\S]*setDeriver\(gcpCloudRunDeriver\(\)\)[\s\S]*deployed name differs from the module name/,
        );
    });

    it('the deriver is OPTIONAL — mappings alone resolve (localhost is a per-service port TABLE)', async () => {
        ClientRegistry.addMapping('helper-fsdb', 8401);
        ClientRegistry.addMapping('helper-portal', 8201);

        expect(await ClientRegistry.resolve('helper-fsdb')).toBe('http://localhost:8401');
        expect(await ClientRegistry.resolve('helper-portal')).toBe('http://localhost:8201');
    });

    it('clear() removes the deriver too, so it cannot leak into the next spec', async () => {
        ClientRegistry.setDeriver((svc: string) =>
            Promise.resolve(`https://${svc}.derived.example`),
        );
        ClientRegistry.clear();

        expect(await ClientRegistry.tryResolve('helper-fsdb')).toBeUndefined();
    });
});

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

/**
 * The webpieces DEFAULTS an app's translator DELEGATES to when an error is not its own. The real
 * ones live downstream (`ApiErrorHttpMapper.toResponse`, `ClientErrorTranslator.builtInError`) and
 * core-util cannot import them, so these stand in for the shape: a translator ALWAYS answers, and
 * "not mine" is spelled as a call, never as `undefined`.
 */
class FrameworkDefault {
    // webpieces-disable no-function-outside-class -- stand-in for the downstream default
    static toWire(error: Error): HttpResponseDto {
        const pe = new ApiErrorPayload();
        pe.message = error.message;
        return new HttpResponseDto(new HttpResponseStatus(500, 'Internal Server Error'), [], pe);
    }
}

/**
 * Bidirectional translators for {@link AiBadRequestError}: exception <-> the WHOLE response. Note
 * the header — the old (statusCode, protocolError) pair could not carry one at all. Neither method
 * returns `undefined`: an unclaimed error is handed to the framework default instead.
 */
class AiErrorTranslators implements ErrorTranslators {
    toWire(error: Error): HttpResponseDto {
        if (!(error instanceof AiBadRequestError)) {
            return FrameworkDefault.toWire(error);
        }
        const pe = new ApiErrorPayload();
        pe.message = error.message;
        return new HttpResponseDto(
            new HttpResponseStatus(460, 'AI Bad Request'),
            [new HttpHeader('x-ai-hint', 'retry-with-shorter-prompt')],
            pe,
        );
    }
    fromWire(response: HttpResponseDto): Error | undefined {
        if (response.status.code !== 460) {
            return undefined; // not claimed -> the built-in mapping, and not
        } // marked app-registered
        const pe = response.body as ApiErrorPayload;
        return new AiBadRequestError(pe.message ?? 'AI bad request');
    }
}

/** The response an app's `fromWire` is handed. Built here the way a client's factory builds it. */
const wireResponse = (code: number, pe: ApiErrorPayload = new ApiErrorPayload()): HttpResponseDto =>
    new HttpResponseDto(new HttpResponseStatus(code, ''), [], pe);

/**
 * The app's ONE ErrorTranslators. The registry answers exactly one question — is one installed? —
 * and the translator it hands back answers EVERY error on the SERVER half, declining by delegating
 * to the webpieces default rather than by returning `undefined`. The CLIENT half keeps `undefined`
 * because there it means "I do not CLAIM this status", which is provenance the caller acts on.
 */
describe('ClientRegistry error translators', () => {
    beforeEach(() => {
        ClientRegistry.clear();
    });

    it('with none installed, the registry reports none — there is no per-error undefined', () => {
        expect(ClientRegistry.getErrorTranslators()).toBeUndefined();
    });

    it('round-trips a custom type: toWire then fromWire reproduces the typed error', () => {
        ClientRegistry.setErrorTranslators(new AiErrorTranslators());
        const translators = ClientRegistry.getErrorTranslators()!;

        const wire = translators.toWire(new AiBadRequestError('bad ai input'));
        expect(wire.status.code).toBe(460);
        expect(wire.status.reason).toBe('AI Bad Request');
        expect(wire.headers.map((h: HttpHeader) => h.name)).toEqual(['x-ai-hint']);

        const rebuilt = translators.fromWire(wire);
        expect(rebuilt).toBeInstanceOf(AiBadRequestError);
        expect((rebuilt as AiBadRequestError).statusCode).toBe(460);
        expect(rebuilt.message).toBe('bad ai input');
    });

    it('a translator that does not claim the error/response DELEGATES to the default', () => {
        ClientRegistry.setErrorTranslators(new AiErrorTranslators());
        const translators = ClientRegistry.getErrorTranslators()!;

        expect(translators.toWire(new Error('other')).status.code).toBe(500);
        expect(translators.fromWire(wireResponse(503))).toBeUndefined();
    });

    it('can OVERRIDE a built-in status (400) — the app replaces webpieces, it is not consulted first', () => {
        const override: ErrorTranslators = {
            toWire: (error: Error) => FrameworkDefault.toWire(error),
            fromWire: (response: HttpResponseDto) =>
                response.status.code === 400
                    ? new AiBadRequestError(
                          (response.body as ApiErrorPayload).message ?? 'overridden 400',
                      )
                    : undefined,
        };
        ClientRegistry.setErrorTranslators(override);

        expect(ClientRegistry.getErrorTranslators()!.fromWire(wireResponse(400))).toBeInstanceOf(
            AiBadRequestError,
        );
    });

    it('SET replaces — a second install is the only one consulted, so precedence is never implicit', () => {
        ClientRegistry.setErrorTranslators(new AiErrorTranslators());
        ClientRegistry.setErrorTranslators({
            toWire: (error: Error) => FrameworkDefault.toWire(error),
            fromWire: () => undefined,
        });

        expect(
            ClientRegistry.getErrorTranslators()!.toWire(new AiBadRequestError('x')).status.code,
        ).toBe(500);
    });

    it('clear() drops the translators too, so they cannot leak into the next spec', () => {
        ClientRegistry.setErrorTranslators(new AiErrorTranslators());
        ClientRegistry.clear();

        expect(ClientRegistry.getErrorTranslators()).toBeUndefined();
    });
});
