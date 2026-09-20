import { afterEach, describe, expect, it } from 'vitest';
import {
    ApiBadRequestError,
    ApiConnectionError,
    ApiDependencyError,
    ApiEndUserError,
    ApiError,
    ApiErrorPayload,
    ApiImplementationError,
    ApiNotFoundError,
    ApiUnavailableError,
} from '@webpieces/core-util/errors';
import {
    IpcCallContext,
    IpcClientErrorTranslator,
    IpcErrorTranslator,
    IpcFailure,
    IpcRegistry,
    IpcReply,
    IpcSuccess,
    toError,
    WebpiecesDefaultIpcErrorTranslator,
} from '@webpieces/core-util/ipc';

const context = new IpcCallContext('tx-1', 'call-1');

const failureOf = (error: Error): IpcReply =>
    new IpcFailure(context, new WebpiecesDefaultIpcErrorTranslator().toWire(error));

const success = (): IpcReply => new IpcSuccess(context, { ok: true });

const caught = (reply: IpcReply): Error => {
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- this helper IS the catch
    try {
        IpcClientErrorTranslator.throwIfFailure(reply);
    } catch (err: unknown) {
        const error = toError(err);
        return error;
    }
    throw new Error('expected a throw, got a normal return');
};

afterEach(() => IpcRegistry.resetForTests());

/**
 * Issue #968 / R7. IPC had both halves of this pair already, hand-rolled at three call sites with no
 * app seam. It now has the identical shape HTTP and MCP have: one registry per protocol, a
 * non-optional `getErrorTranslator()`, an always-installed webpieces default, and one unconditional
 * line at each call site.
 */
describe('IpcRegistry', () => {
    it('is NEVER undefined — a fresh process already holds the webpieces default', () => {
        expect(IpcRegistry.getErrorTranslator()).toBeInstanceOf(WebpiecesDefaultIpcErrorTranslator);
    });

    it('set REPLACES, and resetForTests restores the webpieces default', () => {
        const mine: IpcErrorTranslator = new WebpiecesDefaultIpcErrorTranslator();
        IpcRegistry.setErrorTranslator(mine);
        expect(IpcRegistry.getErrorTranslator()).toBe(mine);

        IpcRegistry.resetForTests();
        expect(IpcRegistry.getErrorTranslator()).toBeInstanceOf(WebpiecesDefaultIpcErrorTranslator);
    });
});

describe('WebpiecesDefaultIpcErrorTranslator.toWire keeps the ApiErrorBoundary publication rule', () => {
    it('publishes a caller-local ApiConnectionError as implementation — to the PEER, WE are broken', () => {
        const payload = new WebpiecesDefaultIpcErrorTranslator().toWire(
            new ApiConnectionError('our own socket died'),
        );

        expect(payload).toBeInstanceOf(ApiErrorPayload);
        expect(payload.kind).toBe('implementation');
        expect(payload.message).toBe('Internal Error');
    });

    it('publishes an ApiEndUserError faithfully — the one message written for a human', () => {
        const payload = new WebpiecesDefaultIpcErrorTranslator().toWire(
            new ApiEndUserError('Passwords do not match', 'pw'),
        );

        expect(payload.kind).toBe('end-user');
        expect(payload.message).toBe('Passwords do not match');
        expect(payload.errorCode).toBe('pw');
    });
});

/**
 * The SAME `ReceivedApiErrorRule` the HTTP client half applies, so moving a call from IPC to HTTP or
 * back cannot change which team gets paged.
 *
 * BEHAVIOUR CHANGE, deliberately: `IpcClientFactory` used to rethrow `ApiErrorCodec.decode(...)`
 * verbatim, handing the caller the PEER's error type as if this process had produced it.
 */
describe('WebpiecesDefaultIpcErrorTranslator.fromWire applies the uniform rule', () => {
    it('a caller-error kind coming back -> ApiImplementationError: I sent a bad IPC request', () => {
        for (const error of [
            new ApiBadRequestError('missing field'),
            new ApiNotFoundError('no such row'),
        ]) {
            expect(caught(failureOf(error)), error.name).toBeInstanceOf(ApiImplementationError);
        }
    });

    it('a server-side kind coming back -> ApiDependencyError: the PEER broke', () => {
        for (const error of [
            new ApiUnavailableError('still booting'),
            new ApiImplementationError('peer bug'),
        ]) {
            expect(caught(failureOf(error)), error.name).toBeInstanceOf(ApiDependencyError);
        }
    });

    it('an incoming ApiDependencyError is rethrown AS-IS — already attributed further downstream', () => {
        const error = caught(failureOf(new ApiDependencyError('the db behind the peer is down')));

        expect(error).toBeInstanceOf(ApiDependencyError);
        expect(error.message).not.toContain('dependency answered');
    });

    it('an ApiEndUserError is the actor own answer and passes through verbatim', () => {
        const error = caught(failureOf(new ApiEndUserError('Passwords do not match', 'pw')));

        expect(error).toBeInstanceOf(ApiEndUserError);
        expect(error.message).toBe('Passwords do not match');
    });

    it('a SUCCESS reply returns without throwing', () => {
        expect(() => IpcClientErrorTranslator.throwIfFailure(success())).not.toThrow();
    });
});

describe('an app IpcErrorTranslator', () => {
    class Declining implements IpcErrorTranslator {
        private readonly fallback = new WebpiecesDefaultIpcErrorTranslator();
        toWire(error: Error): ApiErrorPayload {
            return this.fallback.toWire(error);
        }
        fromWire(reply: IpcReply): void {
            this.fallback.fromWire(reply);
        }
    }

    it('that only delegates is byte-identical to registering nothing, in BOTH directions', () => {
        const nothingOut = new WebpiecesDefaultIpcErrorTranslator().toWire(
            new ApiNotFoundError('gone'),
        );
        const nothingIn = caught(failureOf(new ApiNotFoundError('gone')));

        IpcRegistry.setErrorTranslator(new Declining());

        expect(IpcRegistry.getErrorTranslator().toWire(new ApiNotFoundError('gone'))).toEqual(
            nothingOut,
        );
        const delegatedIn = caught(failureOf(new ApiNotFoundError('gone')));
        expect(delegatedIn.constructor).toBe(nothingIn.constructor);
        expect(delegatedIn.message).toBe(nothingIn.message);
    });

    it('can turn a SUCCESS reply into a throw — fromWire runs for every reply', () => {
        class Declined extends Error {}
        IpcRegistry.setErrorTranslator({
            toWire: (error: Error) => new WebpiecesDefaultIpcErrorTranslator().toWire(error),
            fromWire: (reply: IpcReply) => {
                if (reply.type === 'success') throw new Declined('the body said no');
                new WebpiecesDefaultIpcErrorTranslator().fromWire(reply);
            },
        });

        expect(() => IpcClientErrorTranslator.throwIfFailure(success())).toThrow(Declined);
    });

    it('that silently returns for a FAILURE is backstopped by the webpieces default', () => {
        IpcRegistry.setErrorTranslator({
            toWire: (error: Error) => new WebpiecesDefaultIpcErrorTranslator().toWire(error),
            fromWire: () => undefined,
        });

        const error = caught(failureOf(new ApiUnavailableError('peer down')));
        expect(error).toBeInstanceOf(ApiDependencyError);
        expect(error).toBeInstanceOf(ApiError);
    });
});
