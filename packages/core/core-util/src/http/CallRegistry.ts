import { Attempt, CallContext, CallStrategy } from './CallStrategy';
import { CallDeadline } from './CallDeadline';
import { TransportDefault } from './TransportDefault';
import { ClientRegistry } from './ClientRegistry';
import { CallOutcome } from './ErrorClassifier';
import { ApiMethodInfo } from './ApiMethodInfo';
import { LogManager } from '../logging/LogManager';
import { LOG_API_CALL_LOGGER_NAME } from './ApiCallLogName';
import { toError } from '../lib/errorUtils';

// The same logger LogApiCall writes its [API-*] lines to, so an attempt line sits beside the final one.
const log = LogManager.getLogger(LOG_API_CALL_LOGGER_NAME);

/**
 * Where a policy applies: every contract (`'ALL'`, which has no method), one contract, or one method
 * of one contract. Exported so other per-call registries (e.g. cloudtasks-client's `GcpTaskRegistry`)
 * scope their settings with the SAME ladder.
 */
export type CallScope = [api: 'ALL'] | [api: Function, methodName?: string];

class CallPolicy {
    timeoutMs?: number;
    // webpieces-disable no-any-unknown -- global policy spans heterogeneous response DTOs
    strategy?: CallStrategy<unknown>;
}

class ApiCallPolicies {
    readonly policy = new CallPolicy();
    readonly methods = new Map<string, CallPolicy>();
}

/**
 * Counts the attempts of ONE call and logs each retried TRANSIENT failure. It wraps the attempt
 * BEFORE any strategy sees it, so an app-written strategy gets the same lines as `RetryStrategy`.
 *
 * The line for attempt N is written when attempt N+1 STARTS — i.e. only for an attempt that was
 * actually retried. The last attempt's failure is what escapes, and `LogApiCall`'s final
 * `[API-client-resp-FAIL]` line covers it, so a call that gave up after 4 attempts logs 3 attempt
 * lines and 1 FAIL line, never the last failure twice. An EXPECTED or FAILURE attempt is not logged
 * here either; the final line covers it.
 */
class LoggedAttempts<T> {
    private attempts = 0;
    private pendingTransient?: Error;

    constructor(
        private readonly context: CallContext,
        private readonly attempt: Attempt<T>,
    ) {}

    readonly run: Attempt<T> = async (timeoutMs: number): Promise<T> => {
        this.flushRetried();
        this.attempts += 1;
        // webpieces-disable no-unmanaged-exceptions -- observe the attempt's failure, rethrow it unchanged
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            return await this.attempt(timeoutMs);
        } catch (err: unknown) {
            const error = toError(err);
            const methodInfo = new ApiMethodInfo('client', this.context.apiName, this.context.methodName);
            this.pendingTransient =
                ClientRegistry.classify(error, methodInfo) === CallOutcome.TRANSIENT_FAILURE
                    ? error
                    : undefined;
            // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- rethrows the attempt's own failure unchanged
            throw err;
        }
    };

    private flushRetried(): void {
        const error = this.pendingTransient;
        if (error === undefined) return;
        this.pendingTransient = undefined;
        log.warn(
            `[API-client-attempt-TRANSIENT] ${this.context.apiName}.${this.context.methodName} ` +
                `attempt ${this.attempts} errorType=${error.constructor.name} error=${error.message}`,
        );
    }
}

/**
 * Shared startup registry for browser RPC, node RPC, and Cloud Tasks ENQUEUE — ONE implementation,
 * every transport calls {@link CallRegistry.execute}.
 *
 * Ladder: strategy method -> API -> ALL first; ANY strategy replaces the ENTIRE timeout ladder.
 * Otherwise timeout method -> API -> ALL. Otherwise the transport's {@link TransportDefault} (its
 * timeout, and its strategy if it has one). A registered TIMEOUT is therefore a decision for a single
 * attempt and also replaces a transport's default strategy; to keep retrying with a different attempt
 * deadline, register a `RetryStrategy` instead.
 *
 * RPC has no default retry (only the application knows whether repeating a POST is safe); Cloud Tasks
 * enqueue does (see `TransportDefault`). An app opts RPC in with
 * `CallRegistry.setStrategy(new RetryStrategy(...).run, CatalogApi)` — and `RetryStrategy` never
 * retries a `WRITE`, even registered at ALL.
 */
export class CallRegistry {
    private static all = new CallPolicy();
    private static readonly apis = new Map<Function, ApiCallPolicies>();

    // webpieces-disable no-function-outside-class -- process-global startup registry
    static setTimeout(timeoutMs: number | undefined, ...scope: CallScope): void {
        if (timeoutMs !== undefined) CallDeadline.validate(timeoutMs);
        CallRegistry.policy(scope[0], scope[1]).timeoutMs = timeoutMs;
    }

    // webpieces-disable no-function-outside-class -- process-global startup registry
    static setStrategy(
        // webpieces-disable no-any-unknown -- registry strategies span heterogeneous response DTOs
        strategy: CallStrategy<unknown> | undefined,
        ...scope: CallScope
    ): void {
        CallRegistry.policy(scope[0], scope[1]).strategy = strategy;
    }

    /**
     * Run one call under its registered policy. `context` names the method (its `methodName` selects
     * the per-method policy) and carries the endpoint's declared operation, so the SAME context a
     * strategy sees is the one the transport's deadline puts on an `ApiCallTimeoutError`.
     *
     * Every attempt is wrapped so a retried TRANSIENT failure logs one
     * `WARN [API-client-attempt-TRANSIENT]` line (see {@link LoggedAttempts}).
     */
    // webpieces-disable no-function-outside-class -- transport-independent policy execution
    static async execute<T>(
        api: Function,
        context: CallContext,
        attempt: Attempt<T>,
        fallback: TransportDefault,
    ): Promise<T> {
        const logged = new LoggedAttempts<T>(context, attempt).run;
        const policies = CallRegistry.apis.get(api);
        const method = policies?.methods.get(context.methodName);
        const strategy = method?.strategy ?? policies?.policy.strategy ?? CallRegistry.all.strategy;
        if (strategy !== undefined) {
            return (await strategy(logged, context)) as T;
        }
        const timeoutMs = method?.timeoutMs ?? policies?.policy.timeoutMs ?? CallRegistry.all.timeoutMs;
        if (timeoutMs !== undefined) {
            return logged(timeoutMs);
        }
        if (fallback.strategy !== undefined) {
            return (await fallback.strategy(logged, context)) as T;
        }
        return logged(fallback.timeoutMs);
    }

    /**
     * The registered TIMEOUT for a call — method -> API -> ALL -> `defaultMs` — ignoring every
     * strategy. For a transport that hands timing to someone else for this call (Cloud Tasks enqueue
     * with caller-supplied gax `CallOptions`) and still needs ONE safety cap so a hung channel cannot
     * block forever. Raise it with {@link CallRegistry.setTimeout}.
     */
    // webpieces-disable no-function-outside-class -- process-global registry lookup
    static resolveTimeout(api: Function, methodName: string, defaultMs: number): number {
        const policies = CallRegistry.apis.get(api);
        return (
            policies?.methods.get(methodName)?.timeoutMs ??
            policies?.policy.timeoutMs ??
            CallRegistry.all.timeoutMs ??
            defaultMs
        );
    }

    // webpieces-disable no-function-outside-class -- process-global registry reset for tests
    static clear(): void {
        CallRegistry.all = new CallPolicy();
        CallRegistry.apis.clear();
    }

    // webpieces-disable no-function-outside-class -- process-global registry storage
    private static policy(api: Function | 'ALL', methodName?: string): CallPolicy {
        if (api === 'ALL') {
            return CallRegistry.all;
        }
        let policies = CallRegistry.apis.get(api);
        if (!policies) {
            policies = new ApiCallPolicies();
            CallRegistry.apis.set(api, policies);
        }
        if (methodName === undefined) return policies.policy;
        let policy = policies.methods.get(methodName);
        if (!policy) {
            policy = new CallPolicy();
            policies.methods.set(methodName, policy);
        }
        return policy;
    }
}
