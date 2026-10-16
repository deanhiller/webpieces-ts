/**
 * Whether the USER is waiting on one api client call (#1293).
 *
 * WHY per CALL and not per endpoint: the same `listResumeItems` is FOREGROUND when the user clicks
 * Refresh and BACKGROUND when a timer polls it. `@Endpoint(..., { hideProgress: true })` is a fact
 * about the ROUTE; this is a fact about the CALL SITE, so it is chosen where the client is built —
 * a browser app builds a second client for the same contract with
 * `new ClientConfig(svcName, role, CallMode.BACKGROUND)`.
 *
 * A failed call carries it as `err.callMode` (see {@link CallModeMarker}), so an app's global error
 * handler can decide "log + report, no dialog" for a background failure with no app-side bookkeeping.
 * The error's CLASS never changes — every `instanceof` check keeps working.
 */
export enum CallMode {
    /** The user is waiting on this call: show progress, and surface its failure. */
    FOREGROUND = 'FOREGROUND',
    /** Nobody is waiting (a poll, a prefetch, a sync): no progress UI, and a failure is not a dialog. */
    BACKGROUND = 'BACKGROUND',
}

/**
 * Parks a {@link CallMode} on the value a generated client call rejected with, and reads it back —
 * the same mechanism, for the same reasons, as `ApiCallSite`: a NON-ENUMERABLE own property, so it
 * never reaches JSON, a structured log record or an error reporter's extra data by accident, and the
 * SAME instance is rethrown so the error's class is untouched.
 *
 * It is typed on `ApiError` (`err.callMode`); {@link CallModeMarker.of} reads it off any thrown value,
 * because an app's own `ErrorTranslator` may reject with a type that is not an `ApiError`.
 */
export class CallModeMarker {
    /** The property name the call mode is parked under on a rejected error. */
    static readonly PROPERTY = 'callMode';

    /**
     * Park `mode` on `failure` WITHOUT changing it. Never clobbers: a failure that already carries a
     * mode keeps the innermost (the call that actually failed), exactly as `ApiCallSite.attachTo`
     * does. A non-`Error` or a frozen/sealed error is left untouched — attaching is a marker and must
     * never itself throw.
     */
    // webpieces-disable no-function-outside-class -- stateless writer paired with of(); webpieces-disable no-any-unknown -- a rejection value is genuinely unknown; only an Error is touched
    static attachTo(failure: unknown, mode: CallMode): void {
        if (!(failure instanceof Error) || !Object.isExtensible(failure)) {
            return;
        }
        if (Object.prototype.hasOwnProperty.call(failure, CallModeMarker.PROPERTY)) {
            return;
        }
        const descriptor: PropertyDescriptor = {
            value: mode,
            enumerable: false,
            writable: false,
            configurable: true,
        };
        Object.defineProperty(failure, CallModeMarker.PROPERTY, descriptor);
    }

    /** The mode a generated client parked on `failure`, or undefined when no client call rejected with it. */
    // webpieces-disable no-function-outside-class -- stateless reader paired with attachTo; webpieces-disable no-any-unknown -- a caught value is genuinely unknown until narrowed here
    static of(failure: unknown): CallMode | undefined {
        if (!(failure instanceof Error)) {
            return undefined;
        }
        // webpieces-disable no-any-unknown -- a property descriptor's value is untyped until narrowed below
        const value: unknown = Object.getOwnPropertyDescriptor(failure, CallModeMarker.PROPERTY)?.value;
        return value === CallMode.FOREGROUND || value === CallMode.BACKGROUND ? value : undefined;
    }
}
