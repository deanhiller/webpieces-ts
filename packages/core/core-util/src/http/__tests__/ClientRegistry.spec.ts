import { describe, it, expect, beforeEach } from 'vitest';
import { ClientRole } from '../../errors/ClientRole';
import { ClientRegistry } from '../ClientRegistry';
import { ErrorTranslator } from '../ErrorTranslator';
import { WebpiecesDefaultErrorTranslator } from '../WebpiecesDefaultErrorTranslator';
import { HttpHeader, HttpResponseDto, HttpResponseStatus } from '../HttpResponseDto';
import { CallOutcome, ErrorClassifier } from '../ErrorClassifier';
import * as coreUtil from '../../index';
import { ApiMethodInfo } from '../ApiMethodInfo';
import {
    ApiBadRequestError,
    ApiDependencyError,
    ApiErrorPayload,
    ApiNotFoundError,
} from '../../errors';

describe('ClientRegistry', () => {
    beforeEach(() => {
        // The registry is a process-global; reset it so specs do not leak into one another.
        ClientRegistry.resetForTests();
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
        ClientRegistry.resetForTests();
        expect(ClientRegistry.tryLookup('server2')).toBeUndefined();
    });
});

/**
 * The ONE precedence chain every client runs: mapping, else deriver, else the caller's fallback
 * (browser -> relative, node -> throw).
 */
describe('ClientRegistry resolution chain', () => {
    beforeEach(() => {
        ClientRegistry.resetForTests();
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
        ClientRegistry.resetForTests();

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
 * Bidirectional translator for {@link AiBadRequestError}: exception <-> the WHOLE response. Note the
 * header — the old (statusCode, protocolError) pair could not carry one at all. NEITHER half returns
 * a sentinel: an unclaimed error is DELEGATED to the always-present webpieces default, on both
 * sides, and `fromWire` THROWS rather than returning an error the caller must remember to throw.
 */
class AiErrorTranslator implements ErrorTranslator {
    private readonly fallback = new WebpiecesDefaultErrorTranslator();

    toWire(error: Error): HttpResponseDto {
        if (!(error instanceof AiBadRequestError)) {
            return this.fallback.toWire(error);
        }
        const pe = new ApiErrorPayload();
        pe.message = error.message;
        return new HttpResponseDto(
            new HttpResponseStatus(460, 'AI Bad Request'),
            [new HttpHeader('x-ai-hint', 'retry-with-shorter-prompt')],
            pe,
        );
    }

    fromWire(response: HttpResponseDto, role: ClientRole): void {
        if (response.status.code !== 460) {
            this.fallback.fromWire(response, role); // not mine -> the webpieces default answers
            return;
        }
        const pe = response.body as ApiErrorPayload;
        throw new AiBadRequestError(pe.message ?? 'AI bad request');
    }
}

/** The response an app's `fromWire` is handed. Built here the way a client's factory builds it. */
const wireResponse = (code: number, pe: ApiErrorPayload = new ApiErrorPayload()): HttpResponseDto =>
    new HttpResponseDto(new HttpResponseStatus(code, ''), [], pe);

/**
 * The process's ONE ErrorTranslator. The registry answers NO question at all any more — it always
 * holds one — and the translator it hands back answers EVERY error and EVERY response, declining by
 * delegating to {@link WebpiecesDefaultErrorTranslator} rather than by returning a sentinel.
 */
describe('ClientRegistry error translator', () => {
    beforeEach(() => {
        ClientRegistry.resetForTests();
    });

    it('is NEVER undefined — a fresh process already has the webpieces default installed', () => {
        expect(ClientRegistry.getErrorTranslator(undefined, undefined)).toBeInstanceOf(WebpiecesDefaultErrorTranslator);
    });

    it('round-trips a custom type: toWire then fromWire throws the typed error back', () => {
        ClientRegistry.setErrorTranslator(new AiErrorTranslator(), 'ALL');
        const translator = ClientRegistry.getErrorTranslator(undefined, undefined);

        const wire = translator.toWire(new AiBadRequestError('bad ai input'));
        expect(wire.status.code).toBe(460);
        expect(wire.status.reason).toBe('AI Bad Request');
        expect(wire.headers.map((h: HttpHeader) => h.name)).toEqual(['x-ai-hint']);

        expect(() => translator.fromWire(wire, ClientRole.SERVER)).toThrowError(
            expect.objectContaining({ message: 'bad ai input' }),
        );
    });

    it('a translator that does not claim the error/response DELEGATES to the default', () => {
        ClientRegistry.setErrorTranslator(new AiErrorTranslator(), 'ALL');
        const translator = ClientRegistry.getErrorTranslator(undefined, undefined);

        expect(translator.toWire(new Error('other')).status.code).toBe(500);
        // 503 is not claimed, so the webpieces default answers — and its answer for a 5xx is
        // ApiDependencyError: the peer broke, not us.
        expect(() => translator.fromWire(wireResponse(503), ClientRole.SERVER)).toThrow(ApiDependencyError);
    });

    it('registering a translator that only delegates is byte-identical to registering nothing', () => {
        const declineEverything: ErrorTranslator = new WebpiecesDefaultErrorTranslator();
        const withNothing = ClientRegistry.getErrorTranslator(undefined, undefined).toWire(new ApiNotFoundError('gone'));

        ClientRegistry.setErrorTranslator(declineEverything, 'ALL');
        const withDelegating = ClientRegistry.getErrorTranslator(undefined, undefined).toWire(
            new ApiNotFoundError('gone'),
        );

        expect(withDelegating).toEqual(withNothing);
    });

    it('can OVERRIDE a built-in status (400) — the app replaces webpieces, it is not consulted first', () => {
        const override: ErrorTranslator = {
            toWire: (error: Error) => new WebpiecesDefaultErrorTranslator().toWire(error),
            fromWire: (response: HttpResponseDto, role: ClientRole) => {
                if (response.status.code !== 400) return;
                throw new AiBadRequestError(
                    (response.body as ApiErrorPayload).message ?? 'overridden 400',
                );
            },
        };
        ClientRegistry.setErrorTranslator(override, 'ALL');

        expect(() => ClientRegistry.getErrorTranslator(undefined, undefined).fromWire(wireResponse(400), ClientRole.SERVER)).toThrow(
            AiBadRequestError,
        );
    });

    it('SET replaces — a second install is the only one consulted, so precedence is never implicit', () => {
        ClientRegistry.setErrorTranslator(new AiErrorTranslator(), 'ALL');
        ClientRegistry.setErrorTranslator(new WebpiecesDefaultErrorTranslator(), 'ALL');

        expect(ClientRegistry.getErrorTranslator(undefined, undefined).toWire(new AiBadRequestError('x')).status.code).toBe(
            500,
        );
    });

    it('resetForTests() RESTORES the webpieces default, so nothing leaks into the next spec', () => {
        ClientRegistry.setErrorTranslator(new AiErrorTranslator(), 'ALL');
        ClientRegistry.resetForTests();

        expect(ClientRegistry.getErrorTranslator(undefined, undefined)).toBeInstanceOf(WebpiecesDefaultErrorTranslator);
    });
});

/** A classifier that answers `verdict` for one error type and DEFERS (undefined) for everything else. */
class OneTypeClassifier implements ErrorClassifier {
    constructor(
        private readonly type: Function,
        private readonly verdict: CallOutcome,
    ) {}

    classify(error: Error): CallOutcome | undefined {
        return error instanceof this.type ? this.verdict : undefined;
    }
}

/** Synthetic contract classes: the ladder is keyed by the CLASS, never by its name. */
class VendorApi {}
class SaveApi {}

const info = (side: 'client' | 'server', contract: Function | undefined, methodName: string): ApiMethodInfo =>
    new ApiMethodInfo(side, contract?.name ?? 'NoContract', methodName, undefined, undefined, false, false, false, contract);

describe('ClientRegistry.classify ladder (method -> API -> ALL -> webpieces built-in)', () => {
    const vendorSend = info('client', VendorApi, 'send');
    const vendorList = info('client', VendorApi, 'list');
    const internal = info('client', SaveApi, 'save');
    const server = info('server', SaveApi, 'save');

    beforeEach(() => ClientRegistry.resetForTests());

    it('falls to the webpieces built-in when nothing is registered', () => {
        expect(ClientRegistry.classify(new ApiNotFoundError('x'), vendorSend)).toBe(CallOutcome.FAILURE);
        expect(ClientRegistry.classify(new ApiBadRequestError('x'), server)).toBe(CallOutcome.EXPECTED);
    });

    it('ALL beats the webpieces built-in', () => {
        ClientRegistry.setErrorClassifier(new OneTypeClassifier(ApiNotFoundError, CallOutcome.EXPECTED), 'ALL');
        expect(ClientRegistry.classify(new ApiNotFoundError('x'), internal)).toBe(CallOutcome.EXPECTED);
    });

    it('API beats ALL, for its contract CLASS only', () => {
        ClientRegistry.setErrorClassifier(new OneTypeClassifier(ApiNotFoundError, CallOutcome.FAILURE), 'ALL');
        ClientRegistry.setErrorClassifier(new OneTypeClassifier(ApiNotFoundError, CallOutcome.EXPECTED), VendorApi);
        expect(ClientRegistry.classify(new ApiNotFoundError('x'), vendorSend)).toBe(CallOutcome.EXPECTED);
        expect(ClientRegistry.classify(new ApiNotFoundError('x'), internal)).toBe(CallOutcome.FAILURE);
    });

    it('method beats API, for that method only', () => {
        ClientRegistry.setErrorClassifier(new OneTypeClassifier(ApiNotFoundError, CallOutcome.EXPECTED), VendorApi);
        ClientRegistry.setErrorClassifier(
            new OneTypeClassifier(ApiNotFoundError, CallOutcome.TRANSIENT_FAILURE),
            VendorApi,
            'send',
        );
        expect(ClientRegistry.classify(new ApiNotFoundError('x'), vendorSend)).toBe(CallOutcome.TRANSIENT_FAILURE);
        expect(ClientRegistry.classify(new ApiNotFoundError('x'), vendorList)).toBe(CallOutcome.EXPECTED);
    });

    it('a deferring classifier falls through every rung down to the built-in', () => {
        ClientRegistry.setErrorClassifier(new OneTypeClassifier(ApiNotFoundError, CallOutcome.EXPECTED), VendorApi, 'send');
        ClientRegistry.setErrorClassifier(new OneTypeClassifier(ApiBadRequestError, CallOutcome.EXPECTED), VendorApi);
        ClientRegistry.setErrorClassifier(
            new OneTypeClassifier(ApiDependencyError, CallOutcome.TRANSIENT_FAILURE),
            'ALL',
        );
        expect(ClientRegistry.classify(new ApiBadRequestError('x'), vendorSend)).toBe(CallOutcome.EXPECTED);
        expect(ClientRegistry.classify(new ApiDependencyError('x'), vendorSend)).toBe(
            CallOutcome.TRANSIENT_FAILURE,
        );
        expect(ClientRegistry.classify(new Error('boom'), vendorSend)).toBe(CallOutcome.FAILURE);
    });

    it('a call with no contract class reaches the ALL rung alone', () => {
        ClientRegistry.setErrorClassifier(new OneTypeClassifier(Error, CallOutcome.TRANSIENT_FAILURE), VendorApi);
        ClientRegistry.setErrorClassifier(new OneTypeClassifier(Error, CallOutcome.EXPECTED), 'ALL');
        expect(ClientRegistry.classify(new Error('boom'), info('client', undefined, 'send'))).toBe(
            CallOutcome.EXPECTED,
        );
    });

    it('resetForTests restores the built-in default and forgets every rung', () => {
        ClientRegistry.setErrorClassifier(new OneTypeClassifier(Error, CallOutcome.EXPECTED), 'ALL');
        ClientRegistry.setErrorClassifier(new OneTypeClassifier(Error, CallOutcome.EXPECTED), VendorApi);
        ClientRegistry.resetForTests();
        expect(ClientRegistry.classify(new Error('boom'), vendorSend)).toBe(CallOutcome.FAILURE);
    });
});

/** A translator that renders one fixed status, so a spec can see WHICH rung answered. */
class StatusTranslator implements ErrorTranslator {
    private readonly fallback = new WebpiecesDefaultErrorTranslator();

    constructor(private readonly code: number) {}

    toWire(): HttpResponseDto {
        return new HttpResponseDto(new HttpResponseStatus(this.code, 'Rung'), [], undefined);
    }

    fromWire(response: HttpResponseDto, role: ClientRole): void {
        this.fallback.fromWire(response, role);
    }
}

describe('ClientRegistry.getErrorTranslator ladder (method -> API -> ALL -> webpieces default)', () => {
    beforeEach(() => ClientRegistry.resetForTests());

    const code = (api: Function | undefined, methodName: string | undefined): number =>
        ClientRegistry.getErrorTranslator(api, methodName).toWire(new Error('x')).status.code;

    it('ALL beats the webpieces default', () => {
        expect(code(SaveApi, 'save')).toBe(500);
        ClientRegistry.setErrorTranslator(new StatusTranslator(471), 'ALL');
        expect(code(SaveApi, 'save')).toBe(471);
    });

    it('API beats ALL, and another contract keeps ALL', () => {
        ClientRegistry.setErrorTranslator(new StatusTranslator(471), 'ALL');
        ClientRegistry.setErrorTranslator(new StatusTranslator(472), VendorApi);
        expect(code(VendorApi, 'send')).toBe(472);
        expect(code(SaveApi, 'save')).toBe(471);
    });

    it('method beats API, and a sibling method keeps the API translator', () => {
        ClientRegistry.setErrorTranslator(new StatusTranslator(472), VendorApi);
        ClientRegistry.setErrorTranslator(new StatusTranslator(473), VendorApi, 'send');
        expect(code(VendorApi, 'send')).toBe(473);
        expect(code(VendorApi, 'list')).toBe(472);
    });

    it('no route (an unmatched request, a failure before routing) reaches ALL alone', () => {
        ClientRegistry.setErrorTranslator(new StatusTranslator(472), VendorApi);
        expect(code(undefined, undefined)).toBe(500);
        ClientRegistry.setErrorTranslator(new StatusTranslator(471), 'ALL');
        expect(code(undefined, undefined)).toBe(471);
    });
});

/**
 * The removed spellings. Their COMPILE errors are pinned in ErrorLadderCompileAssertions.ts (tsc
 * compiles it; a spec's @ts-expect-error is inert). This asserts the runtime surface too: nothing is
 * left behind as an alias.
 */
describe('the deleted unscoped classifier surface', () => {
    it('ClientRegistry has no setDefaultErrorClassifier / addErrorClassifier', () => {
        expect('setDefaultErrorClassifier' in ClientRegistry).toBe(false);
        expect('addErrorClassifier' in ClientRegistry).toBe(false);
        expect(typeof ClientRegistry.setErrorClassifier).toBe('function');
    });

    it('core-util no longer exports KeyedErrorClassifier', () => {
        expect('KeyedErrorClassifier' in coreUtil).toBe(false);
    });
});
