import { afterEach, describe, expect, it } from 'vitest';
import {
    ApiClientTooOldError,
    ApiCodedError,
    ApiEndUserError,
    ApiImplementationError,
    ApiUnauthorizedError,
} from './ApiError';
import { ApiErrorCodec } from './ApiErrorCodec';
import { ClientRole } from './ClientRole';
import { EndUserErrorCode } from './EndUserErrorCode';
import { EndUserErrorRegistry } from './EndUserErrorRegistry';
import {
    ApiEndUserBadRequestError,
    ApiEndUserForbiddenError,
    ApiEndUserNotFoundError,
} from './EndUserErrors';
import { toError } from '../lib/errorUtils';
import { HttpResponseDto, HttpResponseStatus } from '../http/HttpResponseDto';
import { WebpiecesDefaultErrorTranslator } from '../http/WebpiecesDefaultErrorTranslator';
import { IpcCallContext, IpcFailure, IpcReply } from '../ipc/IpcProtocol';
import { WebpiecesDefaultIpcErrorTranslator } from '../ipc/WebpiecesDefaultIpcErrorTranslator';

/**
 * Issues #1172 and #1173: what a RECEIVER rebuilds from the wire.
 *
 * Every case is a round trip through the real `toWire` of the protocol under test, so the spec proves
 * that what a webpieces peer actually publishes decodes back into the intended type, on HTTP and on
 * IPC, which share `ReceivedApiErrorRule` and `ApiErrorCodec`.
 */

const http = new WebpiecesDefaultErrorTranslator();
const ipc = new WebpiecesDefaultIpcErrorTranslator();
const context = new IpcCallContext('tx-1', 'call-1');

const receivedHttp = (response: HttpResponseDto, role: ClientRole): Error => {
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- this spec IS the catch
    try {
        http.fromWire(response, role);
    } catch (err: unknown) {
        const error = toError(err);
        return error;
    }
    throw new Error(`fromWire returned for HTTP ${response.status.code}; expected a throw`);
};

/** The error a receiver of `role` throws for `original` published over HTTP. */
const viaHttp = (original: Error, role: ClientRole): Error =>
    receivedHttp(http.toWire(original), role);

/** The error a receiver of `role` throws for `original` published over IPC. */
const viaIpc = (original: Error, role: ClientRole): Error => {
    const reply: IpcReply = new IpcFailure(context, ipc.toWire(original));
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- this spec IS the catch
    try {
        ipc.fromWire(reply, role);
    } catch (err: unknown) {
        const error = toError(err);
        return error;
    }
    throw new Error('fromWire returned for an IPC failure; expected a throw');
};

class Protocol {
    constructor(
        readonly name: string,
        readonly receive: (original: Error, role: ClientRole) => Error,
    ) {}
}

const PROTOCOLS = [new Protocol('HTTP', viaHttp), new Protocol('IPC', viaIpc)];
const ROLES = [ClientRole.SERVER, ClientRole.END_USER_CLIENT];

/** An app's own subclass, written exactly the way the documented pattern says. */
class TermsNotAcceptedError extends ApiEndUserError {
    static readonly CODE = 'terms-not-accepted';

    constructor(message: string, detail?: string, cause?: Error) {
        super(
            message,
            EndUserErrorCode.format(TermsNotAcceptedError.CODE, detail),
            undefined,
            cause,
        );
    }
}

const registerTerms = (): void =>
    EndUserErrorRegistry.register(
        TermsNotAcceptedError.CODE,
        (message: string, detail: string | undefined) => new TermsNotAcceptedError(message, detail),
    );

afterEach(() => {
    EndUserErrorRegistry.resetForTests();
});

describe('#1172 ApiClientTooOldError (HTTP 426, client-too-old)', () => {
    it('publishes HTTP 426 Upgrade Required with the fixed code', () => {
        const wire = http.toWire(new ApiClientTooOldError('build 41 < minimum 42'));

        expect(wire.status.code).toBe(426);
        expect(wire.status.reason).toBe('Upgrade Required');
        expect(wire.body).toMatchObject({
            kind: 'coded',
            statusCode: 426,
            errorCode: 'client-too-old',
        });
    });

    for (const protocol of PROTOCOLS) {
        for (const role of ROLES) {
            it(`${protocol.name}, received by a ${role}: decodes back into ApiClientTooOldError`, () => {
                const received = protocol.receive(new ApiClientTooOldError('too old'), role);

                expect(received).toBeInstanceOf(ApiClientTooOldError);
                expect(received).not.toBeInstanceOf(ApiImplementationError);
                const coded = received as ApiClientTooOldError;
                expect(coded.statusCode).toBe(426);
                expect(coded.errorCode).toBe(ApiClientTooOldError.CODE);
            });
        }

        it(`${protocol.name}: survives every hop of a chain (server relays, browser receives)`, () => {
            const atServer = protocol.receive(
                new ApiClientTooOldError('too old'),
                ClientRole.SERVER,
            );
            const atBrowser = protocol.receive(atServer, ClientRole.END_USER_CLIENT);

            expect(atBrowser).toBeInstanceOf(ApiClientTooOldError);
        });
    }

    it('a coded 426 with a DIFFERENT code stays a plain coded error', () => {
        const received = ApiErrorCodec.decode(
            ApiErrorCodec.encode(new ApiCodedError('x', 426, 'something-else')),
        );

        expect(received).toBeInstanceOf(ApiCodedError);
        expect(received).not.toBeInstanceOf(ApiClientTooOldError);
    });

    it('a FOREIGN 426 (no webpieces payload) is still "I called wrong"', () => {
        const foreign = new HttpResponseDto(
            new HttpResponseStatus(426, 'Upgrade Required'),
            [],
            'old',
        );

        expect(receivedHttp(foreign, ClientRole.END_USER_CLIENT)).toBeInstanceOf(
            ApiImplementationError,
        );
    });
});

describe('#1173 a received 401 depends on WHO received it', () => {
    for (const protocol of PROTOCOLS) {
        it(`${protocol.name}: an END-USER CLIENT decodes it as ApiUnauthorizedError`, () => {
            const received = protocol.receive(
                new ApiUnauthorizedError('session expired', 'wronglogin'),
                ClientRole.END_USER_CLIENT,
            );

            expect(received).toBeInstanceOf(ApiUnauthorizedError);
            expect((received as ApiUnauthorizedError).subType).toBe('wronglogin');
        });

        it(`${protocol.name}: a SERVER keeps it as ApiImplementationError (its own credential)`, () => {
            const received = protocol.receive(
                new ApiUnauthorizedError('bad service token'),
                ClientRole.SERVER,
            );

            expect(received).toBeInstanceOf(ApiImplementationError);
            expect(received).not.toBeInstanceOf(ApiUnauthorizedError);
        });
    }

    it('a SERVER relaying the decoded failure publishes a 500, not a 401, to its own caller', () => {
        const atServer = viaHttp(new ApiUnauthorizedError('bad service token'), ClientRole.SERVER);

        expect(http.toWire(atServer).status.code).toBe(500);
    });

    it('a FOREIGN 401 without the unauthorized payload is not trusted as a session expiry', () => {
        const foreign = new HttpResponseDto(new HttpResponseStatus(401, 'Unauthorized'), [], 'no');

        expect(receivedHttp(foreign, ClientRole.END_USER_CLIENT)).toBeInstanceOf(
            ApiImplementationError,
        );
    });
});

describe('#1173 EndUserErrorRegistry: the receiving side rebuilds the SUBCLASS', () => {
    for (const protocol of PROTOCOLS) {
        it(`${protocol.name}: an app subclass registered once round-trips as itself`, () => {
            registerTerms();

            const received = protocol.receive(
                new TermsNotAcceptedError('Please accept the new terms', 'v7'),
                ClientRole.END_USER_CLIENT,
            );

            expect(received).toBeInstanceOf(TermsNotAcceptedError);
            const typed = received as TermsNotAcceptedError;
            expect(typed.message).toBe('Please accept the new terms');
            expect(typed.errorCode).toBe('terms-not-accepted:v7');
        });

        it(`${protocol.name}: the webpieces generics decode typed with no setup`, () => {
            const notFound = protocol.receive(
                new ApiEndUserNotFoundError('That report was deleted', 'report-9'),
                ClientRole.SERVER,
            );
            const forbidden = protocol.receive(
                new ApiEndUserForbiddenError('Only the owner can delete this'),
                ClientRole.END_USER_CLIENT,
            );
            const badRequest = protocol.receive(
                new ApiEndUserBadRequestError('The passwords do not match'),
                ClientRole.END_USER_CLIENT,
            );

            expect(notFound).toBeInstanceOf(ApiEndUserNotFoundError);
            expect((notFound as ApiEndUserNotFoundError).errorCode).toBe('user-not-found:report-9');
            expect((notFound as ApiEndUserNotFoundError).edgeHttpStatus).toBe(404);
            expect(forbidden).toBeInstanceOf(ApiEndUserForbiddenError);
            expect(badRequest).toBeInstanceOf(ApiEndUserBadRequestError);
            expect((badRequest as ApiEndUserBadRequestError).edgeHttpStatus).toBe(400);
        });

        it(`${protocol.name}: an UNKNOWN code decodes to the base type with errorCode intact`, () => {
            const received = protocol.receive(
                new TermsNotAcceptedError('Please accept the new terms', 'v7'),
                ClientRole.END_USER_CLIENT,
            );

            expect(received.constructor).toBe(ApiEndUserError);
            expect((received as ApiEndUserError).errorCode).toBe('terms-not-accepted:v7');
            expect(received.message).toBe('Please accept the new terms');
        });
    }

    it('a subclass survives a relaying server: still itself at the end-user client', () => {
        const atServer = viaHttp(new ApiEndUserNotFoundError('gone'), ClientRole.SERVER);

        expect(viaIpc(atServer, ClientRole.END_USER_CLIENT)).toBeInstanceOf(
            ApiEndUserNotFoundError,
        );
    });

    it('refuses a code with a ":" (the grammar is <code>[:<detail>]) and an empty code', () => {
        const factory = (message: string): ApiEndUserError => new ApiEndUserError(message);

        expect(() => EndUserErrorRegistry.register('a:b', factory)).toThrow(ApiImplementationError);
        expect(() => EndUserErrorRegistry.register('', factory)).toThrow(ApiImplementationError);
    });

    it('refuses a second registration of one code, including a webpieces built-in', () => {
        const factory = (message: string): ApiEndUserError => new ApiEndUserError(message);
        EndUserErrorRegistry.register('dup', factory);

        expect(() => EndUserErrorRegistry.register('dup', factory)).toThrow(/already registered/);
        expect(() => EndUserErrorRegistry.register(ApiEndUserNotFoundError.CODE, factory)).toThrow(
            /already registered/,
        );
    });

    it('resetForTests keeps the built-ins and drops app registrations', () => {
        registerTerms();
        EndUserErrorRegistry.resetForTests();

        expect(EndUserErrorRegistry.create('m', 'terms-not-accepted').constructor).toBe(
            ApiEndUserError,
        );
        expect(EndUserErrorRegistry.create('m', 'user-not-found')).toBeInstanceOf(
            ApiEndUserNotFoundError,
        );
    });
});

describe('EndUserErrorCode grammar', () => {
    it('formats and splits <code>[:<detail>], the detail keeping any further colons', () => {
        expect(EndUserErrorCode.format('c')).toBe('c');
        expect(EndUserErrorCode.format('c', 'd')).toBe('c:d');
        expect(EndUserErrorCode.codeOf('c')).toBe('c');
        expect(EndUserErrorCode.detailOf('c')).toBeUndefined();
        expect(EndUserErrorCode.codeOf('c:d:e')).toBe('c');
        expect(EndUserErrorCode.detailOf('c:d:e')).toBe('d:e');
    });
});
