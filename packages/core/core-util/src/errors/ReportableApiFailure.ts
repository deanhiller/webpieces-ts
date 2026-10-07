import { ApiCallSite } from './ApiCallSite';

/**
 * The report-time wrapper for a failed api call: named `RpcCallFailed`, message
 * `Api.method failed: <original message>`, the CALL SITE's stack, and `cause` = the original error.
 *
 * NEVER THROWN. It exists only to be handed to an error reporter, so that the reported stack is the
 * app line that made the call while the original failure (and its own framework stack) is still
 * one `cause` hop away. Here `cause` is honest — the call failed BECAUSE of the original error —
 * which is exactly why the call site itself is not stored as the original's `cause`.
 */
export class RpcCallFailed extends Error {
    constructor(
        public readonly callSite: ApiCallSite,
        original: Error,
    ) {
        super(`${callSite.label} failed: ${original.message}`, { cause: original });
        this.name = 'RpcCallFailed';
        this.stack = `${this.name}: ${this.message}\n${RpcCallFailed.framesOf(callSite)}`;
    }

    /**
     * The call site's frames without its own header line. V8 prefixes a stack with
     * `Name: message`; SpiderMonkey and JavaScriptCore do not, so only a matching first line is cut.
     */
    // webpieces-disable no-function-outside-class -- pure stack-text helper owned by this class
    private static framesOf(callSite: ApiCallSite): string {
        const stack = callSite.stack ?? '';
        const header = `${callSite.name}: ${callSite.message}`;
        if (!stack.startsWith(header)) {
            return stack;
        }
        return stack.slice(header.length).replace(/^\n/, '');
    }
}

/**
 * What an error reporter needs to report a failed api call well: the {@link RpcCallFailed} wrapper
 * and a suggested grouping `fingerprint` of `[original.name, 'Api.method']`, so failures group per
 * endpoint and error type instead of collapsing into one issue for the whole app.
 *
 * Reporter-agnostic on purpose — webpieces does not depend on any error-reporting SDK. A Sentry app,
 * for example, would do:
 *
 * ```ts
 * const report = ReportableApiFailure.toReportableError(err);
 * if (report) Sentry.captureException(report.error, { fingerprint: [...report.fingerprint] });
 * else Sentry.captureException(err);
 * ```
 */
export class ReportableApiFailure {
    constructor(
        public readonly error: RpcCallFailed,
        public readonly fingerprint: readonly string[],
    ) {}

    /**
     * The reportable form of `failure`, or undefined when it carries no call site (it did not come
     * out of a generated api client, so there is nothing to add — report it as it is).
     */
    // webpieces-disable no-function-outside-class -- stateless factory over a caught value; webpieces-disable no-any-unknown -- a caught value is genuinely unknown until narrowed here
    static toReportableError(failure: unknown): ReportableApiFailure | undefined {
        const callSite = ApiCallSite.of(failure);
        if (callSite === undefined || !(failure instanceof Error)) {
            return undefined;
        }
        return new ReportableApiFailure(new RpcCallFailed(callSite, failure), [
            failure.name,
            callSite.label,
        ]);
    }
}
