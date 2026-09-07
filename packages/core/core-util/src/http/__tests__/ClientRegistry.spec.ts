import { describe, it, expect, beforeEach } from 'vitest';
import { ClientRegistry } from '../ClientRegistry';
import { ErrorTranslators } from '../ErrorTranslators';
import { HttpHeader, HttpResponseDto, HttpResponseStatus } from '../HttpResponseDto';
import { FailureClassifier } from '../FailureClassifier';
import { ApiMethodInfo } from '../ApiMethodInfo';
import { ProtocolError, HttpError, HttpNotFoundError, HttpBadRequestError } from '../errors';

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
        ClientRegistry.setDeriver((svc: string) => Promise.resolve(`https://${svc}.derived.example`));

        expect(await ClientRegistry.resolve('helper-fsdb')).toBe('http://localhost:8401');
    });

    it('derives when there is no mapping', async () => {
        ClientRegistry.setDeriver((svc: string) => Promise.resolve(`https://${svc}.derived.example`));

        expect(await ClientRegistry.resolve('helper-fsdb')).toBe('https://helper-fsdb.derived.example');
    });

    it('an EMPTY-STRING mapping is a legal answer (same-origin) and does NOT fall through to the deriver', async () => {
        // The truthiness bug this guards: `if (override)` would skip '' and derive instead.
        ClientRegistry.addUrlMapping('helper-portal', '');
        ClientRegistry.setDeriver((svc: string) => Promise.resolve(`https://${svc}.derived.example`));

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
        ClientRegistry.setDeriver((svc: string) => Promise.resolve(`https://${svc}.derived.example`));
        ClientRegistry.clear();

        expect(await ClientRegistry.tryResolve('helper-fsdb')).toBeUndefined();
    });
});

/** A custom app error at HTTP 460 — the concrete driver (mirrors a consumer app's HttpAiBadRequestError). */
class AiBadRequestError extends HttpError {
    constructor(message: string) {
        super(message, 460);
        this.name = 'AiBadRequest';
        Object.setPrototypeOf(this, new.target.prototype);
    }
}

/**
 * Bidirectional translators for {@link AiBadRequestError}: exception <-> the WHOLE response. Note
 * the header — the old (statusCode, protocolError) pair could not carry one at all.
 */
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
            [new HttpHeader('x-ai-hint', 'retry-with-shorter-prompt')],
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

/** The response an app's `fromWire` is handed. Built here the way a client's factory builds it. */
const wireResponse = (code: number, pe: ProtocolError = new ProtocolError()): HttpResponseDto =>
    new HttpResponseDto(new HttpResponseStatus(code, ''), [], pe);

/**
 * The app's ONE ErrorTranslators: consulted BEFORE the generic webpieces mapping in BOTH directions,
 * stepping aside on `undefined`, and owning the ENTIRE response when it does claim an error.
 */
describe('ClientRegistry error translators', () => {
    beforeEach(() => {
        ClientRegistry.clear();
    });

    it('with none installed, both directions return undefined', () => {
        expect(ClientRegistry.tryTranslateFromWire(wireResponse(460))).toBeUndefined();
        expect(ClientRegistry.tryTranslateToWire(new AiBadRequestError('nope'))).toBeUndefined();
    });

    it('round-trips a custom type: toWire then fromWire reproduces the typed error', () => {
        ClientRegistry.setErrorTranslators(new AiErrorTranslators());

        const wire = ClientRegistry.tryTranslateToWire(new AiBadRequestError('bad ai input'));
        expect(wire).toBeDefined();
        expect(wire?.status.code).toBe(460);
        expect(wire?.status.reason).toBe('AI Bad Request');
        expect(wire?.headers.map((h: HttpHeader) => h.name)).toEqual(['x-ai-hint']);

        const rebuilt = ClientRegistry.tryTranslateFromWire(wire!);
        expect(rebuilt).toBeInstanceOf(AiBadRequestError);
        expect((rebuilt as HttpError).code).toBe(460);
        expect(rebuilt?.message).toBe('bad ai input');
    });

    it('a translator that does not claim the error/response steps aside (undefined)', () => {
        ClientRegistry.setErrorTranslators(new AiErrorTranslators());

        expect(ClientRegistry.tryTranslateToWire(new HttpError('other', 503))).toBeUndefined();
        expect(ClientRegistry.tryTranslateFromWire(wireResponse(503))).toBeUndefined();
    });

    it('can OVERRIDE a built-in status (400) — the app is consulted before webpieces', () => {
        const override: ErrorTranslators = {
            toWire: () => undefined,
            fromWire: (response: HttpResponseDto) =>
                response.status.code === 400
                    ? new AiBadRequestError((response.body as ProtocolError).message ?? 'overridden 400')
                    : undefined,
        };
        ClientRegistry.setErrorTranslators(override);

        expect(ClientRegistry.tryTranslateFromWire(wireResponse(400))).toBeInstanceOf(AiBadRequestError);
    });

    it('SET replaces — a second install is the only one consulted, so precedence is never implicit', () => {
        ClientRegistry.setErrorTranslators(new AiErrorTranslators());
        ClientRegistry.setErrorTranslators({
            toWire: () => undefined,
            fromWire: () => undefined,
        });

        expect(ClientRegistry.tryTranslateToWire(new AiBadRequestError('x'))).toBeUndefined();
    });

    it('clear() drops the translators too, so they cannot leak into the next spec', () => {
        ClientRegistry.setErrorTranslators(new AiErrorTranslators());
        ClientRegistry.clear();

        expect(ClientRegistry.tryTranslateFromWire(wireResponse(460))).toBeUndefined();
    });
});

const client = (apiClass: string): ApiMethodInfo => new ApiMethodInfo('client', apiClass, 'someMethod');
const server = (apiClass: string): ApiMethodInfo => new ApiMethodInfo('server', apiClass, 'someMethod');

/**
 * Pluggable failure classification: per-apiClass EXTERNAL-client classifier → app default → webpieces
 * built-in, resolved most-specific-first, deferring on `undefined`.
 */
describe('ClientRegistry failure classification', () => {
    beforeEach(() => {
        ClientRegistry.clear();
    });

    it('with nothing registered, uses the webpieces built-in (server 4xx = non-failure, client = failure)', () => {
        // server rejecting the caller's bad request is a NON-failure...
        expect(ClientRegistry.classifyFailure(new HttpBadRequestError('bad'), server('SaveApi'))).toBe(false);
        // ...but a client RECEIVING that same 4xx failed its call.
        expect(ClientRegistry.classifyFailure(new HttpBadRequestError('bad'), client('SaveApi'))).toBe(true);
    });

    it('a per-apiClass classifier overrides the default for THAT client only', () => {
        // Firestore: a not-found miss is EXPECTED (non-failure); other errors defer to the default.
        const firestore: FailureClassifier = {
            isFailure: (error: Error) => (error instanceof HttpNotFoundError ? false : undefined),
        };
        ClientRegistry.addFailureClassifier('FirestoreAdminClient', firestore);

        // A 404 on the firestore client is now a NON-failure...
        expect(ClientRegistry.classifyFailure(new HttpNotFoundError('miss'), client('FirestoreAdminClient'))).toBe(false);
        // ...but a 404 on a DIFFERENT client still hits the built-in (client → failure).
        expect(ClientRegistry.classifyFailure(new HttpNotFoundError('miss'), client('SaveApi'))).toBe(true);
        // ...and a non-404 on firestore DEFERS to the built-in (client → failure).
        expect(ClientRegistry.classifyFailure(new Error('boom'), client('FirestoreAdminClient'))).toBe(true);
    });

    it('a per-apiClass classifier that DEFERS falls through to the app default', () => {
        // App default: on the CLIENT side, treat everything as a non-failure (lenient company policy).
        const appDefault: FailureClassifier = {
            isFailure: (_error: Error, m: ApiMethodInfo) => (m.side === 'client' ? false : undefined),
        };
        ClientRegistry.setDefaultFailureClassifier(appDefault);
        // Per-client classifier that always defers.
        ClientRegistry.addFailureClassifier('FirestoreAdminClient', { isFailure: () => undefined });

        // per-client defers → app default claims it (client → non-failure)
        expect(ClientRegistry.classifyFailure(new Error('x'), client('FirestoreAdminClient'))).toBe(false);
        // no per-client entry, app default defers on server → built-in (server non-4xx → failure)
        expect(ClientRegistry.classifyFailure(new Error('x'), server('SaveApi'))).toBe(true);
    });

    it('an unregistered external client is FAIL-SAFE (falls to built-in → failure on the client)', () => {
        expect(ClientRegistry.classifyFailure(new Error('boom'), client('TwilioApi'))).toBe(true);
    });

    it('clear() empties the default AND per-apiClass classifiers', () => {
        ClientRegistry.setDefaultFailureClassifier({ isFailure: () => false });
        ClientRegistry.addFailureClassifier('FirestoreAdminClient', { isFailure: () => false });
        ClientRegistry.clear();

        // Back to the built-in: a client error is a failure again.
        expect(ClientRegistry.classifyFailure(new Error('x'), client('FirestoreAdminClient'))).toBe(true);
    });
});
