import { CallContext } from './CallStrategy';
import { TimeoutError } from './TimeoutError';

/** Transport deadline. The race bounds even transports that ignore cancellation. */
export class CallDeadline {
    /**
     * AbortController.abort(reason) is not portable: React Native's abort-controller 3 signal has
     * neither `reason` nor `throwIfAborted`. Keep the typed failure beside the signal instead.
     */
    private static readonly failures = new WeakMap<AbortSignal, Error>();

    // webpieces-disable no-function-outside-class -- stateless transport helper
    static validate(timeoutMs: number): void {
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
            throw new RangeError('timeoutMs must be positive, finite, and at most 2147483647');
        }
    }

    // webpieces-disable no-function-outside-class -- stateless transport helper
    static async run<T>(
        timeoutMs: number,
        context: CallContext,
        work: (signal: AbortSignal) => Promise<T>,
    ): Promise<T> {
        CallDeadline.validate(timeoutMs);
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const expired = new Promise<never>(
            (_resolve: (value: never) => void, reject: (error: Error) => void) => {
                timer = setTimeout(() => {
                    const error = new TimeoutError(timeoutMs, context);
                    CallDeadline.failures.set(controller.signal, error);
                    reject(error);
                    controller.abort(error);
                }, timeoutMs);
            },
        );
        // webpieces-disable no-unmanaged-exceptions -- release the timer on every settlement
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            return await Promise.race([
                expired,
                Promise.resolve().then(() => work(controller.signal)),
            ]);
        } finally {
            clearTimeout(timer);
        }
    }

    /** Throw the exact deadline failure without relying on optional AbortSignal extensions. */
    // webpieces-disable no-function-outside-class -- portable transport helper
    static throwIfAborted(signal: AbortSignal): void {
        if (!signal.aborted) return;
        throw (
            CallDeadline.failures.get(signal) ??
            new Error('The operation was aborted before it could complete')
        );
    }
}
