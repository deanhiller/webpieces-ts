/**
 * Any function value used as the TOP of a captured stack: every frame from it upward is dropped.
 * Its parameters are irrelevant, so `never[]` lets every generated client method be passed as-is.
 */
// webpieces-disable no-any-unknown -- any function may be a boundary; its return value is never read
export type CallSiteBoundary = (...args: never[]) => unknown;

/**
 * V8's (and SpiderMonkey's) non-standard stack-trimming hook. It is not in the ES `lib` typings and
 * not every engine has it, so it is read through this optional shape rather than assumed.
 */
interface StackTraceCapturer {
    captureStackTrace?: (target: object, boundary?: CallSiteBoundary) => void;
}

/**
 * WHERE the app called a generated api client method — captured synchronously on the CALLER's
 * stack, before the request was sent, and parked on the failure the call rejected with (#1175).
 *
 * WHY IT EXISTS: an api failure is CONSTRUCTED when the response arrives (`ClientErrorTranslator`,
 * `ReceivedApiErrorRule`), long after the stack that made the call has unwound. Its own stack is
 * therefore all framework frames — zone.js, `ProxyClient`, the translator — and not one frame of app
 * code. Measured in a consuming app's error reporter, that meant (1) no way to see which line of app
 * code made the failing call, and (2) every rpc failure in the app grouped into ONE issue, because
 * every one ends in the same framework frames. One `new Error()` per call is cheap; the stack string
 * is only formatted if somebody reads it.
 *
 * WHERE IT LIVES: the property `callSite` on the rejected error, NON-ENUMERABLE so it never reaches
 * a `JSON.stringify`, a structured log record or an error reporter's "extra data" by accident. It is
 * typed on {@link ApiError} (`err.callSite`); {@link ApiCallSite.of} reads it off any thrown value,
 * because an app's own `ErrorTranslator` may reject with a type that is not an `ApiError`.
 *
 * Deliberately NOT `cause`: error reporters follow `cause` as "this error was caused by that one",
 * which would claim the server's 500 was caused by the click handler and bury the useful frames.
 * Use {@link ReportableApiFailure.toReportableError} to build the report-time wrapper instead.
 *
 * It is an `Error` subclass only so that engines and reporters treat its `stack` as a real stack.
 * It is never thrown.
 */
export class ApiCallSite extends Error {
    /** The property name the call site is parked under on a rejected error. */
    static readonly PROPERTY = 'callSite';

    private constructor(
        public readonly apiName: string,
        public readonly methodName: string,
    ) {
        super(`${apiName}.${methodName} was called here`);
        this.name = 'ApiCallSite';
    }

    /** `Api.method` — the endpoint identity, for messages and grouping. */
    get label(): string {
        return `${this.apiName}.${this.methodName}`;
    }

    /**
     * Capture the caller's stack NOW. Call it synchronously as the first statement of the generated
     * client method, passing that method as `boundary`, so the top frame is the app's own line.
     *
     * Where the engine has no `Error.captureStackTrace` the stack keeps the client method's own frame
     * on top of the caller's — one extra frame, never a missing one.
     */
    // webpieces-disable no-function-outside-class -- the factory is the only way to build one, and it must run on the caller's stack
    static capture(apiName: string, methodName: string, boundary: CallSiteBoundary): ApiCallSite {
        const site = new ApiCallSite(apiName, methodName);
        const capturer = Error as StackTraceCapturer;
        if (typeof capturer.captureStackTrace === 'function') {
            capturer.captureStackTrace(site, boundary);
        }
        return site;
    }

    /**
     * Park this call site on the value a call rejected with, WITHOUT changing that value: the same
     * instance is rethrown, so every `instanceof` check downstream keeps working.
     *
     * Never clobbers: a failure that already carries a call site (an inner client call whose error
     * propagated out through an outer one) keeps the innermost, which is the line that actually made
     * the failing request. A non-`Error` or a frozen/sealed error is left untouched — attaching is a
     * diagnostic nicety and must never itself throw.
     */
    // webpieces-disable no-any-unknown -- a rejection value is genuinely unknown; only an Error is touched
    attachTo(failure: unknown): void {
        if (!(failure instanceof Error) || !Object.isExtensible(failure)) {
            return;
        }
        if (Object.prototype.hasOwnProperty.call(failure, ApiCallSite.PROPERTY)) {
            return;
        }
        const descriptor: PropertyDescriptor = {
            value: this,
            enumerable: false,
            writable: false,
            configurable: true,
        };
        Object.defineProperty(failure, ApiCallSite.PROPERTY, descriptor);
    }

    /** The call site parked on `failure` by a generated client, or undefined when there is none. */
    // webpieces-disable no-function-outside-class -- stateless reader paired with attachTo; webpieces-disable no-any-unknown -- a caught value is genuinely unknown until narrowed here
    static of(failure: unknown): ApiCallSite | undefined {
        if (!(failure instanceof Error)) {
            return undefined;
        }
        // webpieces-disable no-any-unknown -- a property descriptor's value is untyped until narrowed below
        const value: unknown = Object.getOwnPropertyDescriptor(
            failure,
            ApiCallSite.PROPERTY,
        )?.value;
        return value instanceof ApiCallSite ? value : undefined;
    }
}
