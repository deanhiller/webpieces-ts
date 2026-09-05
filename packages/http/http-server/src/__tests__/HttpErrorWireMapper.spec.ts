import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
    ClientRegistry,
    ProtocolError,
    HttpError,
    HttpBadRequestError,
    HttpUserError,
    HttpVendorError,
    HttpNotFoundError,
    HttpTimeoutError,
    HttpUnauthorizedError,
    HttpForbiddenError,
    HttpInternalServerError,
    HttpBadGatewayError,
    HttpServiceUnavailableError,
    HttpGatewayTimeoutError,
    HttpTooManyRequestsError,
    EndpointNotFoundError,
    ErrorTranslation,
    ErrorWireForm,
    HeaderRegistry,
    LogManager,
    LoggerFactory,
    Logger,
    WRONG_LOGIN,
} from '@webpieces/core-util';
import { ExpressWrapper } from '../ExpressWrapper';

/**
 * The wire is the ONE place operator prose must not appear. These specs drive the real
 * {@link ExpressWrapper.handleError} — not the mapper in isolation — because the leak was a property
 * of the response BODY, so the assertion has to be made on the bytes that are actually sent.
 *
 * Companion: `WebpiecesMiddlewareErrorTranslation.spec.ts` covers the registry-override path.
 */

/** Records every line any logger emits, so a spec can assert what was WITHHELD is still recorded. */
class CapturingLoggerFactory implements LoggerFactory {
    readonly lines: string[] = [];
    getLogger(_name: string): Logger {
        const record = (message: string): void => {
            this.lines.push(message);
        };
        return { trace: record, debug: record, info: record, warn: record, error: record };
    }
}

/** Captures what handleError writes: status code and the serialized body. */
class FakeResponse {
    public statusCode?: number;
    public body?: string;
    public headersSent = false;

    status(code: number): this {
        this.statusCode = code;
        return this;
    }
    setHeader(_name: string, _value: string): this {
        return this;
    }
    send(payload: string): this {
        this.body = payload;
        this.headersSent = true;
        return this;
    }
}

/** A custom app error at HTTP 461 with its own bidirectional translation — the explicit opt-out. */
class VendorPortalError extends HttpError {
    constructor(message: string) {
        super(message, 461);
        this.name = 'VendorPortalError';
        Object.setPrototypeOf(this, new.target.prototype);
    }
}

class VendorPortalTranslation implements ErrorTranslation {
    toWire(error: Error): ErrorWireForm | undefined {
        if (!(error instanceof VendorPortalError)) {
            return undefined;
        }
        const pe = new ProtocolError();
        pe.message = error.message;
        pe.name = error.name;
        return new ErrorWireForm(461, pe);
    }
    fromWire(statusCode: number, pe: ProtocolError): Error | undefined {
        return statusCode === 461 ? new VendorPortalError(pe.message ?? 'portal') : undefined;
    }
}

/**
 * The whole suite is instance methods on one class so the helpers obey `no-function-outside-class`
 * while still being reachable from every `it` block.
 */
class WireHarness {
    // webpieces-disable no-any-unknown -- test double: handleError only touches status/setHeader/send/headersSent
    private asResponse(fake: FakeResponse): import('express').Response {
        return fake as unknown as import('express').Response;
    }

    private newWrapper(): ExpressWrapper {
        return new ExpressWrapper(
            () => Promise.resolve({}),
            '/test',
            // webpieces-disable no-any-unknown -- RequestContextHeaders is unused by handleError
            {} as unknown as ConstructorParameters<typeof ExpressWrapper>[2],
        );
    }

    /** Run an error through the REAL handleError and hand back status + parsed body + raw body. */
    public send(error: unknown): FakeResponse {
        const res = new FakeResponse();
        this.newWrapper().handleError(this.asResponse(res), error);
        return res;
    }

    public bodyOf(res: FakeResponse): ProtocolError {
        return JSON.parse(res.body ?? '{}') as ProtocolError;
    }

}

const harness = new WireHarness();
const capturing = new CapturingLoggerFactory();

beforeAll(() => {
    if (!HeaderRegistry.isConfigured()) {
        HeaderRegistry.configure([], /*platformHeaders*/ false);
    }
    LogManager.setFactory(capturing);
});

beforeEach(() => {
    ClientRegistry.clear();
    capturing.lines.length = 0;
});

describe('handleError — only HttpUserError message reaches the wire', () => {
    /**
     * One row per non-user subclass: the operator message it was thrown with, and the generic text
     * the caller must see instead. `secret` is deliberately distinctive so `toContain` is decisive.
     */
    const cases: ReadonlyArray<readonly [string, HttpError, number, string]> = [
        ['HttpBadRequestError', new HttpBadRequestError('column users.ssn failed CHECK'), 400, 'Bad Request'],
        ['HttpUnauthorizedError', new HttpUnauthorizedError('jwt kid=internal-signer-7 expired'), 401, 'Unauthorized'],
        ['HttpForbiddenError', new HttpForbiddenError('role admin-internal required on tenant 4471'), 403, 'Forbidden'],
        ['HttpNotFoundError', new HttpNotFoundError('no row in pg.stores where id=88213'), 404, 'Not Found'],
        ['HttpTimeoutError', new HttpTimeoutError('upstream pg-dataaccess:8443 did not answer in 30s'), 408, 'Request Timeout'],
        ['HttpTooManyRequestsError', new HttpTooManyRequestsError('bucket tenant-4471 drained'), 429, 'Too Many Requests'],
        ['HttpInternalServerError', new HttpInternalServerError('ECONNREFUSED 10.4.0.9:5432'), 500, 'Internal Server Error'],
        ['HttpBadGatewayError', new HttpBadGatewayError('nginx upstream sidecar-auth refused'), 502, 'Bad Gateway'],
        ['HttpServiceUnavailableError', new HttpServiceUnavailableError('cloud run revision api-00042-xyz booting'), 503, 'Service Unavailable'],
        ['HttpGatewayTimeoutError', new HttpGatewayTimeoutError('alb idle timeout on /internal/sync'), 504, 'Gateway Timeout'],
        ['HttpVendorError', new HttpVendorError('stripe key sk_live_51H... rate limited'), 598, 'Vendor Error'],
    ];

    for (const [name, error, status, generic] of cases) {
        it(`${name} sends the generic message, never error.message`, () => {
            const res = harness.send(error);
            const pe = harness.bodyOf(res);

            expect(res.statusCode).toBe(status);
            expect(pe.message).toBe(generic);
            expect(res.body).not.toContain(error.message);
            // The operator text is not lost — it moved to the log.
            expect(capturing.lines.join('\n')).toContain(error.message);
        });
    }

    it('a bare HttpError with an app status gets a code-free generic message', () => {
        const res = harness.send(new HttpError('shard 3 of cluster prod-eu is read-only', 466));

        expect(res.statusCode).toBe(466);
        expect(harness.bodyOf(res).message).toBe('Request Failed');
        expect(res.body).not.toContain('shard 3');
    });

    it('never sends `name` — an internal class name is not contract data', () => {
        // EndpointNotFoundError is the sharp case: its `name` IS the internal class name.
        const res = harness.send(new EndpointNotFoundError('no route POST /internal/reindex'));

        expect(res.statusCode).toBe(404);
        expect(harness.bodyOf(res).name).toBeUndefined();
        expect(res.body).not.toContain('EndpointNotFoundError');
        // ...but it is in the log, so nothing that was previously wire-only is lost.
        expect(capturing.lines.join('\n')).toContain('EndpointNotFoundError');
    });

    it('keeps subType — an app passes it on purpose and the client branches on it', () => {
        const res = harness.send(new HttpUnauthorizedError('bcrypt compare failed for user 991', WRONG_LOGIN));

        expect(harness.bodyOf(res).subType).toBe(WRONG_LOGIN);
        expect(harness.bodyOf(res).message).toBe('Unauthorized');
    });
});

describe('handleError — the PR #709 downstream-diagnostic leak', () => {
    /**
     * The exact shape `NodeProxyClient` + `ResponseBodyReader.describeForeignBody` build when a
     * downstream dependency answers a 4xx: the url we called, the method, the content-type, and a
     * snippet of the html we got back. Excellent in a log, catastrophic on a partner-facing wire.
     */
    const diagnostic =
        'DbStoresApi.fetchStores POST https://pg-dataaccess.internal:8443/db-stores/fetch-stores ' +
        'returned HTTP 404 with content-type "text/html; charset=utf-8" — this response did not come ' +
        'from the webpieces server. body="<pre>Cannot POST /db-stores/fetch-stores</pre>"';

    it('sends none of it to the caller, and all of it to the log', () => {
        const res = harness.send(new HttpInternalServerError(diagnostic));

        expect(res.statusCode).toBe(500);
        expect(harness.bodyOf(res).message).toBe('Internal Server Error');

        const body = res.body ?? '';
        expect(body).not.toContain('pg-dataaccess');
        expect(body).not.toContain('Cannot POST /db-stores/fetch-stores');
        expect(body).not.toContain('text/html');
        expect(body).not.toContain('DbStoresApi');

        const logged = capturing.lines.join('\n');
        expect(logged).toContain('Cannot POST /db-stores/fetch-stores');
        expect(logged).toContain('pg-dataaccess.internal:8443');
    });

    it('logs the cause chain too, since only the log carries it now', () => {
        const cause = new HttpNotFoundError('<pre>Cannot POST /db-stores/fetch-stores</pre>');
        harness.send(new HttpInternalServerError('downstream call failed', cause));

        expect(capturing.lines.join('\n')).toContain('cause=<pre>Cannot POST /db-stores/fetch-stores</pre>');
    });
});

describe('handleError — what still goes out on purpose', () => {
    it('HttpUserError: its message IS the wire, with errorCode', () => {
        const res = harness.send(new HttpUserError('That email is already registered', 'EMAIL_TAKEN'));

        expect(res.statusCode).toBe(266);
        const pe = harness.bodyOf(res);
        expect(pe.message).toBe('That email is already registered');
        expect(pe.errorCode).toBe('EMAIL_TAKEN');
        expect(pe.subType).toBe('USER_ERROR');
    });

    it('HttpBadRequestError: guiAlertMessage + field go out, message does not', () => {
        const res = harness.send(
            new HttpBadRequestError('zod: users.email failed regex at ingest.ts:214', 'email', 'Enter a valid email'),
        );

        const pe = harness.bodyOf(res);
        expect(pe.field).toBe('email');
        expect(pe.guiAlertMessage).toBe('Enter a valid email');
        expect(pe.message).toBe('Bad Request');
        expect(res.body).not.toContain('ingest.ts');
    });

    it('HttpVendorError: waitSeconds goes out', () => {
        const res = harness.send(new HttpVendorError('stripe 429 on acct_1Hxx', 45));

        expect(harness.bodyOf(res).waitSeconds).toBe(45);
    });

    it('an app-registered tryTranslateToWire result is passed through untouched', () => {
        ClientRegistry.addErrorTranslation(new VendorPortalTranslation());

        const res = harness.send(new VendorPortalError('portal says: contract 8812 is suspended'));

        expect(res.statusCode).toBe(461);
        const pe = harness.bodyOf(res);
        // The app chose to publish this text. The framework does not second-guess it.
        expect(pe.message).toBe('portal says: contract 8812 is suspended');
        expect(pe.name).toBe('VendorPortalError');
    });

    it('a non-HttpError still answers the generic 500 it always did', () => {
        const res = harness.send(new TypeError('cannot read property id of undefined at Repo.ts:88'));

        expect(res.statusCode).toBe(500);
        expect(harness.bodyOf(res).message).toBe('Internal Server Error');
        expect(res.body).not.toContain('Repo.ts');
    });
});

/**
 * The SERVER half of the round trip. It ends here on purpose: `http-server` does not depend on
 * `http-client-core` and must not start to for a test's convenience — that edge would be a real
 * architectural coupling recorded in `architecture/dependencies.json`.
 *
 * So the round trip is pinned as two halves that meet on the wire bytes. This block asserts the
 * EXACT bytes a webpieces server emits; `ClientErrorTranslator.spec.ts` ("the exact bodies a
 * webpieces server now emits") feeds those same bytes to the translator and asserts the caller gets
 * the right typed error. Change one and the other's fixture stops describing reality.
 */
describe('the exact wire bytes, so the client half can be pinned against them', () => {
    const emitted: ReadonlyArray<readonly [string, HttpError, number, string]> = [
        ['400', new HttpBadRequestError('internal detail'), 400, 'Bad Request'],
        ['401', new HttpUnauthorizedError('internal detail'), 401, 'Unauthorized'],
        ['403', new HttpForbiddenError('internal detail'), 403, 'Forbidden'],
        ['404', new HttpNotFoundError('internal detail'), 404, 'Not Found'],
        ['408', new HttpTimeoutError('internal detail'), 408, 'Request Timeout'],
        ['429', new HttpTooManyRequestsError('internal detail'), 429, 'Too Many Requests'],
        ['500', new HttpInternalServerError('internal detail'), 500, 'Internal Server Error'],
        ['502', new HttpBadGatewayError('internal detail'), 502, 'Bad Gateway'],
        ['503', new HttpServiceUnavailableError('internal detail'), 503, 'Service Unavailable'],
        ['504', new HttpGatewayTimeoutError('internal detail'), 504, 'Gateway Timeout'],
        ['598', new HttpVendorError('internal detail'), 598, 'Vendor Error'],
    ];

    for (const [label, thrown, status, generic] of emitted) {
        it(`${label} emits exactly {"message":"${generic}"} (plus its contract fields)`, () => {
            const res = harness.send(thrown);
            const pe = harness.bodyOf(res);

            expect(res.statusCode).toBe(status);
            expect(pe.message).toBe(generic);
            expect(pe.name).toBeUndefined();
            expect(res.body).not.toContain('internal detail');
        });
    }

    it('266 emits the human-facing message, errorCode and subType', () => {
        const pe = harness.bodyOf(harness.send(new HttpUserError('Password must be 12+ characters', 'PW_SHORT')));

        expect(pe.message).toBe('Password must be 12+ characters');
        expect(pe.errorCode).toBe('PW_SHORT');
        expect(pe.subType).toBe('USER_ERROR');
    });

    it('401 emits subType, so a caller can still branch on WHY login failed', () => {
        const pe = harness.bodyOf(harness.send(new HttpUnauthorizedError('bcrypt mismatch', WRONG_LOGIN)));

        expect(pe.subType).toBe(WRONG_LOGIN);
        expect(pe.message).toBe('Unauthorized');
    });
});
