import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
    ClientRegistry,
    ApiErrorPayload,
    ApiError,
    ApiErrorCodec,
    ApiBadRequestError,
    ApiEndUserError,
    ApiDependencyBackoffError,
    ApiNotFoundError,
    ApiRequestTimeoutError,
    ApiUnauthorizedError,
    ApiForbiddenError,
    ApiImplementationError,
    ApiDependencyError,
    ApiUnavailableError,
    ApiDependencyTimeoutError,
    ApiRateLimitedError,
    ApiEndpointNotFoundError,
    ApiConnectionError,
    ApiConflictError,
    ApiUnprocessableError,
    ApiPreconditionFailedError,
    ApiUnsupportedMediaTypeError,
    ApiNotImplementedError,
    ApiCodedError,
    ErrorTranslators,
    HttpHeader,
    HttpResponseDto,
    HttpResponseStatus,
    HeaderRegistry,
    LogManager,
    LoggerFactory,
    Logger,
    WRONG_LOGIN,
} from '@webpieces/core-util';
import { ExpressWrapper } from '../ExpressWrapper';
import { EndUserStatus } from '../ApiErrorHttpMapper';

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
    public statusMessage?: string;
    public body?: string;
    public headersSent = false;
    /** Every header written, in order and WITH repeats — the point of the DTO's header list. */
    public readonly headers: Array<[string, string]> = [];

    status(code: number): this {
        this.statusCode = code;
        return this;
    }
    setHeader(name: string, value: string): this {
        this.headers.push([name, value]);
        return this;
    }
    append(name: string, value: string): this {
        this.headers.push([name, value]);
        return this;
    }
    send(payload: string): this {
        this.body = payload;
        this.headersSent = true;
        return this;
    }
}

/** An app's own error class: not an ApiError, and the identity a wrapper used to destroy (#959). */
class LangPassageLockedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'LangPassageLockedError';
        Object.setPrototypeOf(this, new.target.prototype);
    }
}

/** A custom app error at HTTP 461 with its own bidirectional translation — the explicit opt-out. */
class VendorPortalError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'VendorPortalError';
        Object.setPrototypeOf(this, new.target.prototype);
    }
}

class VendorPortalPayload {
    constructor(
        public message: string,
        public name: string,
    ) {}
}

class VendorPortalTranslators implements ErrorTranslators {
    toWire(error: Error): HttpResponseDto | undefined {
        if (!(error instanceof VendorPortalError)) {
            return undefined;
        }
        const pe = new VendorPortalPayload(error.message, error.name);
        return new HttpResponseDto(
            new HttpResponseStatus(461, 'Vendor Portal Suspended'),
            [
                new HttpHeader('retry-after', '600'),
                new HttpHeader('set-cookie', 'portal=a; Path=/'),
                new HttpHeader('set-cookie', 'portalSid=b; Path=/'),
            ],
            pe,
        );
    }
    fromWire(response: HttpResponseDto): Error | undefined {
        if (response.status.code !== 461) {
            return undefined;
        }
        return new VendorPortalError((response.body as VendorPortalPayload).message ?? 'portal');
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

    private newWrapper(endUserStatus: EndUserStatus): ExpressWrapper {
        return new ExpressWrapper(
            () => Promise.resolve({}),
            '/test',
            // webpieces-disable no-any-unknown -- RequestContextHeaders is unused by handleError
            {} as unknown as ConstructorParameters<typeof ExpressWrapper>[2],
            false,
            false,
            undefined,
            undefined,
            undefined,
            endUserStatus,
        );
    }

    /** Run an error through the REAL handleError and hand back status + parsed body + raw body. */
    public send(error: unknown, endUserStatus: EndUserStatus = 'gui'): FakeResponse {
        const res = new FakeResponse();
        this.newWrapper(endUserStatus).handleError(this.asResponse(res), error);
        return res;
    }

    /**
     * One server-to-server hop: what a webpieces client rebuilds from a 266 response body. That is
     * `ApiErrorCodec.decode` on the parsed bytes — `ClientErrorTranslator` (http-client-core, which
     * this package must not depend on) does exactly this once the status agrees with the kind; its
     * own spec and `NodeProxyClient.spec.ts` pin that half.
     */
    public hop(res: FakeResponse): ApiError {
        expect(res.statusCode).toBe(266);
        return ApiErrorCodec.decode(JSON.parse(res.body ?? '{}'));
    }

    public bodyOf(res: FakeResponse): ApiErrorPayload {
        return JSON.parse(res.body ?? '{}') as ApiErrorPayload;
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

describe('handleError — only ApiEndUserError message reaches the wire', () => {
    /**
     * One row per non-user subclass: the operator message it was thrown with, and the generic text
     * the caller must see instead. `secret` is deliberately distinctive so `toContain` is decisive.
     */
    const cases: ReadonlyArray<readonly [string, ApiError, number, string]> = [
        [
            'ApiBadRequestError',
            new ApiBadRequestError('column users.ssn failed CHECK'),
            400,
            'Bad Request',
        ],
        [
            'ApiUnauthorizedError',
            new ApiUnauthorizedError('jwt kid=internal-signer-7 expired'),
            401,
            'Unauthorized',
        ],
        [
            'ApiForbiddenError',
            new ApiForbiddenError('role admin-internal required on tenant 4471'),
            403,
            'Forbidden',
        ],
        [
            'ApiNotFoundError',
            new ApiNotFoundError('no row in pg.stores where id=88213'),
            404,
            'Not Found',
        ],
        [
            'ApiRequestTimeoutError',
            new ApiRequestTimeoutError('upstream pg-dataaccess:8443 did not answer in 30s'),
            408,
            'Request Timeout',
        ],
        [
            'ApiRateLimitedError',
            new ApiRateLimitedError('bucket tenant-4471 drained'),
            429,
            'Rate Limited',
        ],
        [
            'ApiImplementationError',
            new ApiImplementationError('ECONNREFUSED 10.4.0.9:5432'),
            500,
            'Internal Error',
        ],
        [
            'ApiDependencyError',
            new ApiDependencyError('nginx upstream sidecar-auth refused'),
            502,
            'Dependency Error',
        ],
        [
            'ApiUnavailableError',
            new ApiUnavailableError('cloud run revision api-00042-xyz booting'),
            503,
            'Service Unavailable',
        ],
        [
            'ApiDependencyTimeoutError',
            new ApiDependencyTimeoutError('alb idle timeout on /internal/sync'),
            504,
            'Dependency Timeout',
        ],
        [
            'ApiDependencyBackoffError',
            new ApiDependencyBackoffError('stripe key sk_live_51H... rate limited'),
            503,
            'Dependency Unavailable',
        ],
        ['ApiConflictError', new ApiConflictError('row version 7 != 8 on orders'), 409, 'Conflict'],
        [
            'ApiPreconditionFailedError',
            new ApiPreconditionFailedError('etag W/"abc" stale on bucket-internal'),
            412,
            'Precondition Failed',
        ],
        [
            'ApiUnsupportedMediaTypeError',
            new ApiUnsupportedMediaTypeError('parser jsonl-internal rejected text/csv'),
            415,
            'Unsupported Media Type',
        ],
        [
            'ApiUnprocessableError',
            new ApiUnprocessableError('rule engine v3 rejected basket 991'),
            422,
            'Unprocessable Content',
        ],
        [
            'ApiNotImplementedError',
            new ApiNotImplementedError('feature flag legacy-export-internal off'),
            501,
            'Not Implemented',
        ],
        [
            'ApiCodedError(460)',
            new ApiCodedError('vendor quota table q_internal exhausted', 460, 'QUOTA'),
            460,
            'Request Failed',
        ],
        [
            'ApiCodedError(404)',
            new ApiCodedError('named-code collision is allowed: pg row 88213', 404),
            404,
            'Request Failed',
        ],
        [
            'ApiCodedError(507)',
            new ApiCodedError('disk /var/lib/pg-internal full', 507),
            507,
            'Request Failed',
        ],
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

    it('never sends `name` — an internal class name is not contract data', () => {
        // ApiEndpointNotFoundError is the sharp case: its `name` IS the internal class name.
        const res = harness.send(new ApiEndpointNotFoundError('no route POST /internal/reindex'));

        expect(res.statusCode).toBe(404);
        expect(harness.bodyOf(res)).not.toHaveProperty('name');
        expect(res.body).not.toContain('ApiEndpointNotFoundError');
        // ...but it is in the log, so nothing that was previously wire-only is lost.
        expect(capturing.lines.join('\n')).toContain('ApiEndpointNotFoundError');
    });

    it('keeps subType — an app passes it on purpose and the client branches on it', () => {
        const res = harness.send(
            new ApiUnauthorizedError('bcrypt compare failed for user 991', WRONG_LOGIN),
        );

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
        const res = harness.send(new ApiImplementationError(diagnostic));

        expect(res.statusCode).toBe(500);
        expect(harness.bodyOf(res).message).toBe('Internal Error');

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
        const cause = new ApiNotFoundError('<pre>Cannot POST /db-stores/fetch-stores</pre>');
        harness.send(new ApiImplementationError('downstream call failed', cause));

        expect(capturing.lines.join('\n')).toContain(
            'cause=<pre>Cannot POST /db-stores/fetch-stores</pre>',
        );
    });
});

describe('handleError — what still goes out on purpose', () => {
    it('ApiEndUserError: its message IS the wire, with errorCode', () => {
        const res = harness.send(
            new ApiEndUserError('That email is already registered', 'EMAIL_TAKEN'),
        );

        expect(res.statusCode).toBe(266);
        const pe = harness.bodyOf(res);
        expect(pe.message).toBe('That email is already registered');
        expect(pe.errorCode).toBe('EMAIL_TAKEN');
        expect(pe.subType).toBe('USER_ERROR');
    });

    it('ApiBadRequestError: callerMessage + field go out, message does not', () => {
        const res = harness.send(
            new ApiBadRequestError(
                'zod: users.email failed regex at ingest.ts:214',
                'email',
                'Enter a valid email',
            ),
        );

        const pe = harness.bodyOf(res);
        expect(pe.field).toBe('email');
        expect(pe.callerMessage).toBe('Enter a valid email');
        expect(pe.message).toBe('Bad Request');
        expect(res.body).not.toContain('ingest.ts');
    });

    it('ApiDependencyBackoffError: retryAfterSeconds goes out', () => {
        const res = harness.send(new ApiDependencyBackoffError('stripe 429 on acct_1Hxx', 45));

        expect(harness.bodyOf(res).retryAfterSeconds).toBe(45);
        expect(res.headers).toContainEqual(['retry-after', '45']);
    });

    /**
     * THE TRAP (#959). `ApiConnectionError` IS an `ApiError`, so the naive "just encode what was
     * thrown" would publish kind `connection` — and `ApiErrorHttpStatus.code` THROWS on that kind.
     * A caller-local connection failure is this gateway's own bug and must stay a 500
     * `implementation`, byte for byte, with the downstream host never reaching the wire.
     */
    it('publishes a caller-local connection failure as a 500 implementation error', () => {
        const res = harness.send(new ApiConnectionError('ECONNREFUSED private-host:8443'));
        expect(res.statusCode).toBe(500);
        expect(res.statusMessage).toBe('Internal Server Error');
        expect(harness.bodyOf(res)).toMatchObject({
            kind: 'implementation',
            message: 'Internal Error',
        });
        expect(res.body).not.toContain('connection');
        expect(res.body).not.toContain('private-host');
        // The operator STILL sees which class failed — the substitution used to erase exactly this.
        expect(capturing.lines.join('\n')).toContain(
            '[name=ApiConnectionError kind=implementation subType=none] ' +
                'ECONNREFUSED private-host:8443',
        );
    });

    it('keeps a non-ApiError class name in the operator log while publishing nothing of it', () => {
        const res = harness.send(new LangPassageLockedError('passage 7 locked for tenant_7'));

        expect(res.statusCode).toBe(500);
        expect(harness.bodyOf(res)).toMatchObject({
            kind: 'implementation',
            message: 'Internal Error',
        });
        expect(res.body).not.toContain('tenant_7');
        const logged = capturing.lines.join('\n');
        expect(logged).toContain(
            '[name=LangPassageLockedError kind=implementation subType=none] ' +
                'passage 7 locked for tenant_7',
        );
        expect(logged).not.toContain('name=ApiImplementationError');
        // The wrapper used to copy the message in and keep the original as `cause`, printing it twice.
        expect(logged).not.toContain('cause=passage 7 locked');
    });

    it('an app-installed toWire result is passed through untouched — status, REASON and body', () => {
        ClientRegistry.setErrorTranslators(new VendorPortalTranslators());

        const res = harness.send(new VendorPortalError('portal says: contract 8812 is suspended'));

        expect(res.statusCode).toBe(461);
        // The reason phrase is the app's, not node's blank default for an unregistered code.
        expect(res.statusMessage).toBe('Vendor Portal Suspended');
        const pe = harness.bodyOf(res);
        // The app chose to publish this text. The framework does not second-guess it.
        expect(pe.message).toBe('portal says: contract 8812 is suspended');
        expect((pe as unknown as VendorPortalPayload).name).toBe('VendorPortalError');
    });

    it('the app owns HEADERS too — and repeats survive, which a Map would have dropped', () => {
        ClientRegistry.setErrorTranslators(new VendorPortalTranslators());

        const res = harness.send(new VendorPortalError('suspended'));

        expect(res.headers).toContainEqual(['retry-after', '600']);
        expect(res.headers.filter(([name]: [string, string]) => name === 'set-cookie')).toEqual([
            ['set-cookie', 'portal=a; Path=/'],
            ['set-cookie', 'portalSid=b; Path=/'],
        ]);
    });

    it('an unclassified error is normalized to a concrete implementation error', () => {
        const res = harness.send(
            new TypeError('cannot read property id of undefined at Repo.ts:88'),
        );

        expect(res.statusCode).toBe(500);
        expect(harness.bodyOf(res).message).toBe('Internal Error');
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
    const emitted: ReadonlyArray<readonly [string, ApiError, number, string]> = [
        ['400', new ApiBadRequestError('internal detail'), 400, 'Bad Request'],
        ['401', new ApiUnauthorizedError('internal detail'), 401, 'Unauthorized'],
        ['403', new ApiForbiddenError('internal detail'), 403, 'Forbidden'],
        ['404', new ApiNotFoundError('internal detail'), 404, 'Not Found'],
        ['408', new ApiRequestTimeoutError('internal detail'), 408, 'Request Timeout'],
        ['429', new ApiRateLimitedError('internal detail'), 429, 'Rate Limited'],
        ['500', new ApiImplementationError('internal detail'), 500, 'Internal Error'],
        ['502', new ApiDependencyError('internal detail'), 502, 'Dependency Error'],
        ['503', new ApiUnavailableError('internal detail'), 503, 'Service Unavailable'],
        ['504', new ApiDependencyTimeoutError('internal detail'), 504, 'Dependency Timeout'],
        [
            '503-backoff',
            new ApiDependencyBackoffError('internal detail'),
            503,
            'Dependency Unavailable',
        ],
    ];

    for (const [label, thrown, status, generic] of emitted) {
        it(`${label} emits exactly {"message":"${generic}"} (plus its contract fields)`, () => {
            const res = harness.send(thrown);
            const pe = harness.bodyOf(res);

            expect(res.statusCode).toBe(status);
            expect(pe.message).toBe(generic);
            expect(pe).not.toHaveProperty('name');
            expect(res.body).not.toContain('internal detail');
        });
    }

    it('266 emits the human-facing message, errorCode and subType', () => {
        const pe = harness.bodyOf(
            harness.send(new ApiEndUserError('Password must be 12+ characters', 'PW_SHORT')),
        );

        expect(pe.message).toBe('Password must be 12+ characters');
        expect(pe.errorCode).toBe('PW_SHORT');
        expect(pe.subType).toBe('USER_ERROR');
    });

    it('401 emits subType, so a caller can still branch on WHY login failed', () => {
        const pe = harness.bodyOf(
            harness.send(new ApiUnauthorizedError('bcrypt mismatch', WRONG_LOGIN)),
        );

        expect(pe.subType).toBe(WRONG_LOGIN);
        expect(pe.message).toBe('Unauthorized');
    });
});

/**
 * Issue #948: one downstream throw site serves a GUI edge (266) and a partner API edge (a real 4xx).
 * Server A throws; each intermediate server is a GUI-mode hop that rethrows what its client decoded;
 * the outermost server answers in the mode its router chose.
 */
describe('ApiEndUserError.edgeHttpStatus — GUI edge vs API edge', () => {
    it('single hop: B in GUI mode answers 266, B in edge mode answers 422, both with msg + code', () => {
        const atB = harness.hop(
            harness.send(
                new ApiEndUserError('That platform is not supported', 'report_unavailable', 422),
            ),
        );

        const gui = harness.send(atB, 'gui');
        expect(gui.statusCode).toBe(266);
        expect(harness.bodyOf(gui)).toMatchObject({
            kind: 'end-user',
            message: 'That platform is not supported',
            errorCode: 'report_unavailable',
            edgeHttpStatus: 422,
        });

        const edge = harness.send(atB, 'edge');
        expect(edge.statusCode).toBe(422);
        expect(edge.statusMessage).toBe('Unprocessable Content');
        expect(harness.bodyOf(edge)).toMatchObject({
            kind: 'end-user',
            message: 'That platform is not supported',
            errorCode: 'report_unavailable',
        });
    });

    it('two hops (A -> B -> C): the status is preserved to the edge', () => {
        const atB = harness.hop(
            harness.send(new ApiEndUserError('No such report', 'report_not_found', 404)),
        );
        const atC = harness.hop(harness.send(atB));

        const edge = harness.send(atC, 'edge');
        expect(edge.statusCode).toBe(404);
        expect(harness.bodyOf(edge)).toMatchObject({
            message: 'No such report',
            errorCode: 'report_not_found',
        });
        expect(harness.send(atC, 'gui').statusCode).toBe(266);
    });

    it('an older peer that sends no edgeHttpStatus: edge mode answers 400, GUI mode 266', () => {
        const olderPeerBody = { kind: 'end-user', message: 'Pick a store', errorCode: 'store' };
        const atB = ApiErrorCodec.decode(olderPeerBody) as ApiEndUserError;
        expect(atB.edgeHttpStatus).toBeUndefined();

        const edge = harness.send(atB, 'edge');
        expect(edge.statusCode).toBe(400);
        expect(harness.bodyOf(edge)).toMatchObject({ message: 'Pick a store', errorCode: 'store' });
        expect(harness.bodyOf(edge)).not.toHaveProperty('edgeHttpStatus');
        expect(harness.send(atB, 'gui').statusCode).toBe(266);
    });

    it('edge mode changes ONLY end-user errors; every other kind keeps its mapping', () => {
        expect(harness.send(new ApiNotFoundError('row missing'), 'edge').statusCode).toBe(404);
        expect(harness.send(new ApiImplementationError('bug'), 'edge').statusCode).toBe(500);
        expect(harness.send(new ApiUnauthorizedError('jwt'), 'edge').statusCode).toBe(401);
        const bad = harness.send(new ApiBadRequestError('zod', 'email', 'Enter an email'), 'edge');
        expect(bad.statusCode).toBe(400);
        expect(harness.bodyOf(bad).kind).toBe('bad-request');
    });

    it('GUI mode ignores edgeHttpStatus entirely', () => {
        const res = harness.send(new ApiEndUserError('x', 'y', 409));
        expect(res.statusCode).toBe(266);
        expect(res.statusMessage).toBe('End User Error');
    });
});
