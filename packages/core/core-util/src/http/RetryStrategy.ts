import { Attempt, CallContext, CallStrategy } from './CallStrategy';
import { CallDeadline } from './CallDeadline';
import { ClientRegistry } from './ClientRegistry';
import { CallOutcome } from './ErrorClassifier';
import { ApiMethodInfo } from './ApiMethodInfo';
import { WRITE } from './HttpEndpointOptions';
import { ApiRetriesExhaustedError } from '../errors/ApiError';
import { toError } from '../lib/errorUtils';

/**
 * THE webpieces retry strategy, shared by every transport — register its {@link RetryStrategy.run}
 * with `CallRegistry.setStrategy(...)`, or hand it to a `TransportDefault`.
 *
 * Two questions, two owners, and it asks both:
 *
 * - **the ERROR** — `ClientRegistry.classify(error, …)`. Only `CallOutcome.TRANSIENT_FAILURE` is
 *   retried; an EXPECTED or FAILURE outcome is a definitive answer and is rethrown unchanged.
 * - **the ENDPOINT** — `CallContext.operation`. A `WRITE` is NEVER retried, even when this strategy is
 *   registered at ALL: a transient error on a non-idempotent write may already have happened.
 *
 * Each attempt gets its own `attemptTimeoutMs` deadline. Between attempts it waits
 * `initialDelayMs`, then multiplies by `delayMultiplier`, capped at `maxDelayMs`.
 *
 * When it RETRIED and ran out, it throws {@link ApiRetriesExhaustedError} (`cause` = the last
 * attempt's error), which is classified FAILURE so no layer above retries again. A call that made a
 * single attempt — `maxRetries` 0, a `WRITE`, a non-transient error — rethrows its own error unchanged.
 */
export class RetryStrategy {
    /** The {@link CallStrategy} to register. A bound field, so `strategy.run` can be passed around. */
    // webpieces-disable no-any-unknown -- registry strategies span heterogeneous response DTOs
    readonly run: CallStrategy<unknown>;

    constructor(
        readonly attemptTimeoutMs: number,
        readonly maxRetries: number,
        readonly initialDelayMs: number,
        readonly delayMultiplier: number,
        readonly maxDelayMs: number,
    ) {
        CallDeadline.validate(attemptTimeoutMs);
        RetryStrategy.requireWhole('maxRetries', maxRetries);
        RetryStrategy.requireWhole('initialDelayMs', initialDelayMs);
        RetryStrategy.requireWhole('maxDelayMs', maxDelayMs);
        if (!Number.isFinite(delayMultiplier) || delayMultiplier < 1) {
            throw new RangeError('delayMultiplier must be finite and at least 1');
        }
        // webpieces-disable no-any-unknown -- registry strategies span heterogeneous response DTOs
        this.run = (call: Attempt<unknown>, ctx: CallContext): Promise<unknown> => this.execute(call, ctx);
    }

    // webpieces-disable no-any-unknown -- registry strategies span heterogeneous response DTOs
    private async execute(call: Attempt<unknown>, ctx: CallContext): Promise<unknown> {
        const methodInfo = new ApiMethodInfo('client', ctx.apiName, ctx.methodName);
        let delayMs = this.initialDelayMs;
        for (let attempt = 1; ; attempt++) {
            // webpieces-disable no-unmanaged-exceptions -- a strategy decides per failure whether to retry
            // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
            try {
                return await call(this.attemptTimeoutMs);
            } catch (err: unknown) {
                const error = toError(err);
                const retryable =
                    ctx.operation !== WRITE &&
                    ClientRegistry.classify(error, methodInfo) === CallOutcome.TRANSIENT_FAILURE;
                if (!retryable) {
                    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- a definitive answer is rethrown unchanged
                    throw err;
                }
                if (attempt > this.maxRetries) {
                    if (attempt === 1) {
                        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- never retried, so nothing was exhausted
                        throw err;
                    }
                    throw new ApiRetriesExhaustedError(attempt, error);
                }
                await RetryStrategy.sleep(delayMs);
                delayMs = Math.min(delayMs * this.delayMultiplier, this.maxDelayMs);
            }
        }
    }

    // webpieces-disable no-function-outside-class -- constructor argument guard
    private static requireWhole(name: string, value: number): void {
        if (!Number.isInteger(value) || value < 0) {
            throw new RangeError(`${name} must be a non-negative integer`);
        }
    }

    // webpieces-disable no-function-outside-class -- backoff timer
    private static sleep(ms: number): Promise<void> {
        return new Promise<void>((resolve: () => void) => setTimeout(resolve, ms));
    }
}
