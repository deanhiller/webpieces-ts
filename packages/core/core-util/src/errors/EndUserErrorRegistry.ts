import { ApiEndUserError, ApiImplementationError, EdgeHttpStatus } from './ApiError';
import { EndUserErrorCode } from './EndUserErrorCode';
import {
    ApiEndUserBadRequestError,
    ApiEndUserForbiddenError,
    ApiEndUserNotFoundError,
} from './EndUserErrors';

/**
 * Rebuilds one registered {@link ApiEndUserError} subclass from what crossed the wire. It receives
 * the published message and the `<detail>` half of `errorCode` (see {@link EndUserErrorCode}); the
 * subclass's constructor fixes the `<code>` half itself.
 */
export type EndUserErrorFactory = (message: string, detail: string | undefined) => ApiEndUserError;

/**
 * errorCode -> {@link ApiEndUserError} SUBCLASS, so the receiving side of a 266 can `instanceof` WHICH
 * mistake it was (send the person to the Terms page, treat a missing item as "it was deleted")
 * instead of string-matching `errorCode` at every catch site.
 *
 * `ApiErrorCodec` consults it for every decoded `end-user` payload, which is the one decode HTTP
 * (`WebpiecesDefaultErrorTranslator.fromWire`), IPC and JSONL streams all share, so a registration
 * covers every protocol at once. Matching is on the `<code>` half of the `<code>[:<detail>]` grammar.
 * An UNKNOWN code decodes to the base `ApiEndUserError` with `errorCode` and `edgeHttpStatus` intact:
 * forward compatible, an old client receiving a new code still shows the message.
 *
 * REGISTER ONCE AT STARTUP, in EVERY process that may receive the error: the browser bundle, the
 * Expo shell and every server. A server needs it too, because a server that receives a 266 from a
 * peer rethrows the decoded error to its own caller, and only a decoded subclass is still that
 * subclass when the next hop catches it.
 *
 * ```ts
 * export class TermsNotAcceptedError extends ApiEndUserError {
 *     static readonly CODE = 'terms-not-accepted';
 *     constructor(message: string, detail?: string, cause?: Error) {
 *         super(message, EndUserErrorCode.format(TermsNotAcceptedError.CODE, detail), undefined, cause);
 *     }
 * }
 *
 * // startup, ONCE per process (browser AND server)
 * EndUserErrorRegistry.register(TermsNotAcceptedError.CODE,
 *     (message: string, detail: string | undefined) => new TermsNotAcceptedError(message, detail));
 * ```
 *
 * The webpieces generics ({@link ApiEndUserNotFoundError}, {@link ApiEndUserForbiddenError},
 * {@link ApiEndUserBadRequestError}) are PRE-REGISTERED here, so they decode typed with no setup.
 * App-specific subclasses stay in the app.
 *
 * Process-global and static, like `ClientRegistry` / `HeaderRegistry`: the codec that consults it is
 * a static, protocol-neutral decoder reached from the browser, node and IPC alike, and a registration
 * is a fact about the PROCESS's error taxonomy, not about any one client.
 */
export class EndUserErrorRegistry {
    private static readonly factories = EndUserErrorRegistry.builtIns();

    /**
     * Register the subclass for `code`. `code` is the bare `<code>` (no `:`), normally the subclass's
     * static `CODE`. Registering a code twice THROWS: two classes claiming one code is a collision
     * that would otherwise decode to whichever registered last, depending on startup order.
     */
    // webpieces-disable no-function-outside-class -- static global singleton (like ClientRegistry/HeaderRegistry); populated once at startup, never DI-injected
    static register(code: string, factory: EndUserErrorFactory): void {
        if (code.length === 0 || code.includes(EndUserErrorCode.SEPARATOR)) {
            throw new ApiImplementationError(
                `EndUserErrorRegistry.register('${code}'): a code must be non-empty and must not ` +
                    `contain '${EndUserErrorCode.SEPARATOR}'. The errorCode grammar is ` +
                    `<code>[:<detail>]; register the bare <code>, normally the subclass's static CODE.`,
            );
        }
        if (EndUserErrorRegistry.factories.has(code)) {
            throw new ApiImplementationError(
                `EndUserErrorRegistry.register('${code}'): that code is already registered. Two ` +
                    `ApiEndUserError subclasses cannot share one errorCode; rename one of them. ` +
                    `(Tests: call EndUserErrorRegistry.resetForTests() between specs.)`,
            );
        }
        EndUserErrorRegistry.factories.set(code, factory);
    }

    /**
     * The decoded end-user error for a received payload: the registered subclass for `errorCode`'s
     * `<code>`, else the base {@link ApiEndUserError} carrying everything the wire sent.
     */
    // webpieces-disable no-function-outside-class -- static global singleton (like ClientRegistry/HeaderRegistry); populated once at startup, never DI-injected
    static create(
        message: string,
        errorCode?: string,
        edgeHttpStatus?: EdgeHttpStatus,
    ): ApiEndUserError {
        if (errorCode === undefined) return new ApiEndUserError(message, errorCode, edgeHttpStatus);
        const factory = EndUserErrorRegistry.factories.get(EndUserErrorCode.codeOf(errorCode));
        if (factory === undefined) return new ApiEndUserError(message, errorCode, edgeHttpStatus);
        return factory(message, EndUserErrorCode.detailOf(errorCode));
    }

    /** Back to a fresh process: the webpieces built-ins only. For TESTS, so specs cannot leak. */
    // webpieces-disable no-function-outside-class -- static global singleton (like ClientRegistry/HeaderRegistry); populated once at startup, never DI-injected
    static resetForTests(): void {
        EndUserErrorRegistry.factories.clear();
        for (const [code, factory] of EndUserErrorRegistry.builtIns()) {
            EndUserErrorRegistry.factories.set(code, factory);
        }
    }

    // webpieces-disable no-function-outside-class -- the built-in table, shared by the initializer and resetForTests
    private static builtIns(): Map<string, EndUserErrorFactory> {
        return new Map<string, EndUserErrorFactory>([
            [
                ApiEndUserNotFoundError.CODE,
                (message: string, detail: string | undefined) =>
                    new ApiEndUserNotFoundError(message, detail),
            ],
            [
                ApiEndUserForbiddenError.CODE,
                (message: string, detail: string | undefined) =>
                    new ApiEndUserForbiddenError(message, detail),
            ],
            [
                ApiEndUserBadRequestError.CODE,
                (message: string, detail: string | undefined) =>
                    new ApiEndUserBadRequestError(message, detail),
            ],
        ]);
    }
}
