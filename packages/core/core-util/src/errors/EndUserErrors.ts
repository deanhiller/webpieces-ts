import { ApiEndUserError } from './ApiError';
import { EndUserErrorCode } from './EndUserErrorCode';

/*
 * The generic end-user subclasses webpieces ships. Each one follows THE subclass pattern (issue
 * #1173), which an app copies for its own (terms-not-accepted, domain refusals):
 *
 *   1. `CODE` is a static constant and the constructor FIXES it, so a throw site cannot send a missing
 *      or misspelled code; the caller supplies only the message and, optionally, a `detail` (data the
 *      client acts on, never prose — see EndUserErrorCode).
 *   2. It is REGISTERED ONCE at startup, in every process that may receive it (browser bundle, Expo
 *      shell, every server), so `fromWire(toWire(new X(...)))` is an `X` on both ends of every hop:
 *
 *        EndUserErrorRegistry.register(TermsNotAcceptedError.CODE,
 *            (message: string, detail: string | undefined) => new TermsNotAcceptedError(message, detail));
 *
 * These three are pre-registered by webpieces itself (see EndUserErrorRegistry), so they decode typed
 * with no app setup. Their codes carry a `user-` prefix so they cannot collide with an `ApiErrorKind`
 * of the same name and so an app's own short codes stay free.
 */

/**
 * The thing the end user asked about does not exist (or no longer does): "that report was deleted".
 * A partner-facing edge answers 404 for it.
 */
export class ApiEndUserNotFoundError extends ApiEndUserError {
    static readonly CODE = 'user-not-found';

    constructor(message: string, detail?: string, cause?: Error) {
        super(message, EndUserErrorCode.format(ApiEndUserNotFoundError.CODE, detail), 404, cause);
    }
}

/**
 * The end user may not do this, and the message tells them why ("only the owner can delete this
 * board"). Deliberately NOT `ApiForbiddenError`: that is a 403 authorization failure whose text is
 * never published, while this is an expected answer shown to the person verbatim. It sets no
 * `edgeHttpStatus`, because `EdgeHttpStatus` excludes 403 on purpose: authorization keeps its own type.
 */
export class ApiEndUserForbiddenError extends ApiEndUserError {
    static readonly CODE = 'user-forbidden';

    constructor(message: string, detail?: string, cause?: Error) {
        super(
            message,
            EndUserErrorCode.format(ApiEndUserForbiddenError.CODE, detail),
            undefined,
            cause,
        );
    }
}

/**
 * The end user's input was well-formed but wrong in a way they must fix ("the two passwords do not
 * match"). A partner-facing edge answers 400 for it. Distinct from `ApiBadRequestError`, whose
 * `message` is operator-only and which means the CALLER built a bad request.
 */
export class ApiEndUserBadRequestError extends ApiEndUserError {
    static readonly CODE = 'user-bad-request';

    constructor(message: string, detail?: string, cause?: Error) {
        super(message, EndUserErrorCode.format(ApiEndUserBadRequestError.CODE, detail), 400, cause);
    }
}
