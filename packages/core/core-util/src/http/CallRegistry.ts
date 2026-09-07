import { Attempt, CallContext, CallStrategy } from './CallStrategy';
import { CallDeadline } from './CallDeadline';

/** ALL has no method; a contract can optionally select one method. */
type CallScope = [api: 'ALL'] | [api: Function, methodName?: string];

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
 * Shared startup registry for browser RPC, node RPC, and Cloud Tasks ENQUEUE.
 * Strategy method -> API -> ALL first; ANY strategy replaces the ENTIRE timeout ladder.
 * Otherwise timeout method -> API -> ALL -> transport default (30s today).
 * No default retry: only the application knows whether repeating a POST is safe.
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

    // webpieces-disable no-function-outside-class -- transport-independent policy execution
    static async execute<T>(
        api: Function,
        methodName: string,
        attempt: Attempt<T>,
        defaultMs: number,
    ): Promise<T> {
        const policies = CallRegistry.apis.get(api);
        const method = policies?.methods.get(methodName);
        const strategy = method?.strategy ?? policies?.policy.strategy ?? CallRegistry.all.strategy;
        if (strategy !== undefined) {
            return (await strategy(attempt, new CallContext(api.name, methodName))) as T;
        }
        return attempt(
            method?.timeoutMs ??
                policies?.policy.timeoutMs ??
                CallRegistry.all.timeoutMs ??
                defaultMs,
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
