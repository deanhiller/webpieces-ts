import { CallContext } from './CallStrategy';
import { ApiCallTimeoutError } from './ApiCallTimeoutError';
import { DeadlineScheduler, DeadlineTimer } from './DeadlineScheduler';

/**
 * The state of ONE deadline-bounded run. Every transition is guarded so a late native callback, a
 * settlement racing the deadline, or a synchronous failure each act at most once.
 */
class DeadlineRun {
    private failure: ApiCallTimeoutError | undefined;
    private settled = false;
    private timer: DeadlineTimer | undefined;
    readonly controller = new AbortController();
    readonly startedAt: number;
    private rejectExpired!: (error: Error) => void;
    readonly expiry: Promise<never>;

    constructor(
        private readonly timeoutMs: number,
        private readonly context: CallContext,
        private readonly deadlines: DeadlineScheduler,
        private readonly failures: WeakMap<AbortSignal, Error>,
    ) {
        this.startedAt = deadlines.now();
        this.expiry = new Promise<never>(
            (_resolve: (value: never) => void, reject: (error: Error) => void) => {
                this.rejectExpired = reject;
            },
        );
    }

    /** May throw synchronously; nothing was scheduled then, so there is nothing to release. */
    start(): void {
        this.timer = this.deadlines.schedule(this.timeoutMs, this.expire);
    }

    /** The scheduler's callback. Ignored once the run settled: a late native delivery is harmless. */
    readonly expire = (): void => {
        if (this.settled || this.failure !== undefined) return;
        const error = new ApiCallTimeoutError(this.timeoutMs, this.context);
        this.failure = error;
        this.failures.set(this.controller.signal, error);
        this.rejectExpired(error);
        this.controller.abort(error);
    };

    /**
     * Called when the work settles. If the scheduler never delivered (JS suspended, native callback
     * lost) but the budget is spent on the scheduler's clock, the result arrived AFTER its deadline:
     * fail it with the same typed timeout rather than returning it.
     */
    expireIfOverdue(): void {
        if (this.deadlines.now() - this.startedAt >= this.timeoutMs) this.expire();
        if (this.failure !== undefined) throw this.failure;
    }

    /** Exactly once per run, on every settlement path that had a timer to release. */
    finish(): void {
        if (this.settled) return;
        this.settled = true;
        this.timer?.cancel();
    }
}

/**
 * Transport deadline. The race bounds even transports that ignore cancellation, and a body read that
 * never ends: the deadline covers everything inside `work` — URL resolution, filters, auth, the send
 * and the response body — exactly as the caller's per-attempt budget says.
 *
 * Timing comes from the caller's {@link DeadlineScheduler} (#1445), never from a global timer, so a
 * React Native client whose JS timers pause while the phone is locked can still be cancelled by a
 * native-delivered deadline.
 */
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
        deadlines: DeadlineScheduler,
        work: (signal: AbortSignal) => Promise<T>,
    ): Promise<T> {
        CallDeadline.validate(timeoutMs);
        const run = new DeadlineRun(timeoutMs, context, deadlines, CallDeadline.failures);
        run.start();
        const guarded = Promise.resolve()
            .then(() => work(run.controller.signal))
            .then(
                (value: T): T => {
                    run.expireIfOverdue();
                    return value;
                },
                (err: Error): never => {
                    run.expireIfOverdue();
                    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- rethrows the work's own failure unchanged
                    throw err;
                },
            );
        // webpieces-disable no-unmanaged-exceptions -- release the scheduled deadline on every settlement
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            return await Promise.race([run.expiry, guarded]);
        } finally {
            run.finish();
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
