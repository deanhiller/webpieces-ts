import {
    ProtocolError,
    HttpError,
    HttpBadRequestError,
    HttpVendorError,
    HttpUserError,
    HttpNotFoundError,
    HttpTimeoutError,
    HttpUnauthorizedError,
    HttpForbiddenError,
    HttpInternalServerError,
    HttpBadGatewayError,
    HttpGatewayTimeoutError,
    HttpResponseDto,
    HttpResponseStatus,
    LogManager,
    toError,
} from '@webpieces/core-util';

// The logging backend prepends this logger name to every line, so messages below carry NO
// "[HttpErrorWireMapper]" literal of their own — that would print the name twice.
const log = LogManager.getLogger('HttpErrorWireMapper');

/**
 * Turns a thrown {@link HttpError} into the {@link ProtocolError} that goes on the wire — and, just
 * as importantly, decides what does NOT go on the wire.
 *
 * # The rule: only {@link HttpUserError}'s `message` is caller-facing
 *
 * `Error.message` is an OPERATOR-facing field everywhere else in this framework. It is written for
 * whoever reads the logs, and it routinely quotes internal detail: a downstream service url, an HTTP
 * method and content-type, a body snippet, a table name, an internal id. `http-client-node` builds
 * exactly such a message when a downstream dependency answers a 4xx — `ResponseBodyReader`'s
 * foreign-body description names the url it called and embeds the html it got back — and that error
 * arrives here as an `HttpInternalServerError`. Copying `error.message` onto the response body handed
 * every one of those strings to an external, possibly partner-facing consumer.
 *
 * {@link HttpUserError} is the ONE type whose message was written for a human to read. That is what
 * it is FOR: it is deliberately a 266 (a 2xx code, so it is not lumped in with failures), it carries
 * an `errorCode` the caller branches on, and an app throws it on purpose to say something like
 * "Email already exists". Its message goes out verbatim.
 *
 * Every other subclass sends a GENERIC, status-appropriate message (see {@link genericMessage}); the
 * real message goes to the LOG only. The behaviour used to be exactly backwards — an unexpected crash
 * was safely generic while a DELIBERATE `HttpInternalServerError` shipped its full message outward.
 *
 * # What still goes out, and why
 *
 * - `errorCode` ({@link HttpUserError}) and `waitSeconds` ({@link HttpVendorError}) are structured
 *   CONTRACT data the client is meant to branch on, not prose. They carry no internal detail.
 * - `field` and `guiAlertMessage` ({@link HttpBadRequestError}) stay. `guiMessage` exists precisely
 *   to be the human-safe half of a bad request — its existence is the admission that `message` is the
 *   operator-facing half — and a form field name is not internal detail. The `message` itself is
 *   genericised like every other non-user error.
 * - `subType` stays. It is NOT derived from a class name: it is an explicit constructor argument an
 *   app passes on purpose (`WRONG_LOGIN`, `NOT_APPROVED`, `EMAIL_NOT_CONFIRMED`, … from
 *   `core-util/src/http/errors.ts`), which makes it structured contract data of the same kind as
 *   `errorCode`. `ClientErrorTranslator` reads it back when reconstructing `HttpUnauthorizedError`
 *   and the generic `HttpError`, so dropping it would break that reconstruction for the one case —
 *   login failure reasons — where the caller genuinely has to branch on WHY.
 * - `name` is GONE from this ladder. Nothing in `ClientErrorTranslator` ever read it, so it is not
 *   contract data. For a built-in it was a constant string 1:1 with the status code (`'BadRequest'`,
 *   `'InternalServerError'`), i.e. it told the caller nothing the status had not already told it —
 *   and for any SUBCLASS reaching this ladder it was literally an internal class name
 *   (`'EndpointNotFoundError'`, or whatever an app happened to name its type). That is a free read of
 *   the server's internals for zero caller benefit, so it is not sent. It is logged instead.
 *
 * An app that WANTS a different wire shape has an explicit opt-out on both sides:
 * `ClientRegistry.setErrorTranslators()`. `ExpressWrapper.handleError` consults
 * `tryTranslateToWire()` BEFORE reaching this class, and whatever that returns is sent verbatim —
 * that is the app's own deliberate choice about what it publishes.
 *
 * # This class IS the webpieces default, and it is DELEGABLE
 *
 * {@link toResponse} produces the same {@link HttpResponseDto} an app's `ErrorTranslators.toWire`
 * produces, so an app that wants "webpieces' answer, plus one header" or "webpieces' answer for
 * everything except MY type" WRAPS this instead of reimplementing it. That is not hypothetical:
 * a consumer's envelope class carried a status-to-message table with the comment "copied verbatim
 * from HttpErrorWireMapper's own table". Copying framework internals is the symptom of a missing
 * export, so the class and {@link genericMessage} are both public and both exported from this
 * package's barrel.
 */
export class HttpErrorWireMapper {
    /**
     * status code → the generic, caller-safe text sent in its place. These are the standard HTTP
     * reason phrases (plus 266 and 598, webpieces' own user/vendor codes), so a caller reading the
     * body learns exactly what the status line already told it and nothing more.
     *
     * The SAME string is the response's reason phrase in {@link toResponse}. One table, because a
     * status line that disagrees with the body it introduces helps nobody.
     */
    private readonly genericMessages: Map<number, string> = new Map<number, string>([
        [266, 'User Error'],
        [400, 'Bad Request'],
        [401, 'Unauthorized'],
        [403, 'Forbidden'],
        [404, 'Not Found'],
        [408, 'Request Timeout'],
        [429, 'Too Many Requests'],
        [500, 'Internal Server Error'],
        [502, 'Bad Gateway'],
        [503, 'Service Unavailable'],
        [504, 'Gateway Timeout'],
        [598, 'Vendor Error'],
    ]);

    /**
     * Build the wire BODY for `error`, and LOG the operator-facing detail that is being withheld from
     * it. Both halves happen here on purpose: the log line is the only remaining place the real
     * message exists, so it must never be optional or skippable.
     *
     * PRIVATE, deliberately. {@link toResponse} is the one public spelling of "webpieces' default
     * answer" — a public body-only producer alongside it would be a second spelling of the same
     * decision, and the caller who picked it would then hand-wrap a status and headers around the
     * body, re-implementing exactly what `toResponse` exists to hand them.
     */
    private toWire(error: HttpError): ProtocolError {
        const protocolError = new ProtocolError();

        // The ONE type whose message was written for a human to read — see the class doc.
        if (error instanceof HttpUserError) {
            log.info(`User Error: ${this.operatorDetail(error)}`);
            protocolError.message = error.message;
            protocolError.subType = error.subType;
            protocolError.errorCode = error.errorCode;
            return protocolError;
        }

        protocolError.message = this.genericMessage(error.code);
        protocolError.subType = error.subType;
        this.logOperatorDetail(error);
        this.addContractFields(error, protocolError);
        return protocolError;
    }

    /**
     * Build the WHOLE default response for a thrown value — status code, reason phrase, headers and
     * body. This is webpieces' own answer expressed in the SAME {@link HttpResponseDto} an app's
     * `ErrorTranslators.toWire` returns, which is what makes the default delegable: an app wraps it
     * and edits the parts it cares about.
     *
     * Takes `unknown`, not `HttpError`, because the non-HttpError case is part of the default and an
     * app delegating here must get it too: an unexpected throw is a GENERIC 500 whose real message
     * goes to the log only.
     *
     * Note what is NOT here: the `Content-Type` and the transaction-id response header. Both are
     * INFRASTRUCTURE that `ExpressWrapper` writes for every response — success and error, default and
     * app-translated alike — so an app that overrides the error body never has to remember to
     * re-emit them (and, for the content type, can still override it by naming it in its own header
     * list).
     */
    // webpieces-disable no-any-unknown -- a thrown value is genuinely unknown until narrowed below
    public toResponse(error: unknown): HttpResponseDto {
        if (error instanceof HttpError) {
            return new HttpResponseDto(
                new HttpResponseStatus(error.code, this.genericMessage(error.code)),
                [],
                this.toWire(error),
            );
        }

        // Already generic before this class existed, and deliberately so: an unexpected crash must
        // leak nothing. The real error goes to the log.
        log.error('Unexpected error:', toError(error));
        const protocolError = new ProtocolError();
        protocolError.message = 'Internal Server Error';
        return new HttpResponseDto(
            new HttpResponseStatus(500, 'Internal Server Error'),
            [],
            protocolError,
        );
    }

    /**
     * The generic text for a status, or a code-free fallback for an app's own custom status. PUBLIC
     * so an app can reuse the table rather than copy it — see the class doc.
     */
    public genericMessage(code: number): string {
        return this.genericMessages.get(code) ?? 'Request Failed';
    }

    /**
     * The full operator-facing string. `name` and `subType` are in here because `name` used to be
     * visible ONLY on the wire — removing it from the body without adding it to the log would lose it
     * entirely.
     */
    private operatorDetail(error: HttpError): string {
        const cause = error.httpCause === undefined ? '' : ` cause=${error.httpCause.message}`;
        return `[name=${error.name} subType=${error.subType ?? 'none'}] ${error.message}${cause}`;
    }

    /**
     * Log at the level that matches who is at fault: `info` where the CALLER made a mistake (a 4xx is
     * the server behaving correctly), `error` where the server or a dependency is broken.
     */
    private logOperatorDetail(error: HttpError): void {
        const detail = this.operatorDetail(error);
        if (error instanceof HttpBadRequestError) {
            log.info(`Bad Request: ${detail}`);
        } else if (error instanceof HttpNotFoundError) {
            log.info(`Not Found: ${detail}`);
        } else if (error instanceof HttpTimeoutError) {
            log.error(`Timeout Error: ${detail}`);
        } else if (error instanceof HttpVendorError) {
            log.error(`Vendor Error: ${detail}`);
        } else if (error instanceof HttpUnauthorizedError) {
            log.info(`Unauthorized: ${detail}`);
        } else if (error instanceof HttpForbiddenError) {
            log.info(`Forbidden: ${detail}`);
        } else if (error instanceof HttpInternalServerError) {
            log.error(`Internal Server Error: ${detail}`);
        } else if (error instanceof HttpBadGatewayError) {
            log.error(`Bad Gateway: ${detail}`);
        } else if (error instanceof HttpGatewayTimeoutError) {
            log.error(`Gateway Timeout: ${detail}`);
        } else {
            log.info(`Generic HttpError: ${detail}`);
        }
    }

    /**
     * The structured, caller-facing fields — the ones a client BRANCHES on rather than displays as
     * server prose. MUST match ClientErrorTranslator's built-in status mapping.
     */
    private addContractFields(error: HttpError, protocolError: ProtocolError): void {
        if (error instanceof HttpBadRequestError) {
            protocolError.field = error.field;
            // The human-safe half of a bad request. `error.message` is the operator half and is NOT
            // sent — the generic 'Bad Request' went out above instead.
            protocolError.guiAlertMessage = error.guiMessage;
        } else if (error instanceof HttpVendorError) {
            protocolError.waitSeconds = error.waitSeconds;
        }
    }
}
