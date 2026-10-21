import type { CallOptions } from 'google-gax';
import type { CallScope } from '@webpieces/core-util';
import { TaskCustomizer } from './TaskTypes';

class GcpTaskPolicy {
    customizer?: TaskCustomizer;
    gax?: CallOptions;
}

class ApiGcpTaskPolicies {
    readonly policy = new GcpTaskPolicy();
    readonly methods = new Map<string, GcpTaskPolicy>();
}

/**
 * Process-wide Cloud Tasks enqueue defaults, set at startup and resolved method -> API -> ALL — the
 * same {@link CallScope} ladder as `CallRegistry`. A call site's `ScheduleOptions` wins over both.
 *
 * - {@link GcpTaskRegistry.setCustomizer} — a {@link TaskCustomizer} applied to the Google
 *   `ICreateTaskRequest` of every matching enqueue whose call site set none. It changes the REQUEST
 *   only (headers, dispatch deadline, ...); webpieces still owns timing.
 * - {@link GcpTaskRegistry.setGax} — gax `CallOptions` for matching enqueues. Setting them means
 *   YOU own timing for that scope: no webpieces retry strategy runs, there is exactly one attempt,
 *   `createTask(request, yourGax)` is sent as given, and `CallRegistry`'s timeout ladder (method ->
 *   API -> ALL -> 30 s) is a safety cap only. Raise the cap with `CallRegistry.setTimeout(...)` to
 *   give gax retries room.
 *
 * Read only by `TaskProxyClient` (the customizer is applied by `GcpTaskInvoker`; the in-memory
 * invoker has no Google request and ignores both).
 */
export class GcpTaskRegistry {
    private static all = new GcpTaskPolicy();
    private static readonly apis = new Map<Function, ApiGcpTaskPolicies>();

    // webpieces-disable no-function-outside-class -- process-global startup registry
    static setCustomizer(customizer: TaskCustomizer | undefined, ...scope: CallScope): void {
        GcpTaskRegistry.policy(scope[0], scope[1]).customizer = customizer;
    }

    // webpieces-disable no-function-outside-class -- process-global startup registry
    static setGax(gax: CallOptions | undefined, ...scope: CallScope): void {
        GcpTaskRegistry.policy(scope[0], scope[1]).gax = gax;
    }

    /** The registered customizer, method -> API -> ALL, or undefined. */
    // webpieces-disable no-function-outside-class -- process-global registry lookup
    static customizerFor(api: Function, methodName: string): TaskCustomizer | undefined {
        const policies = GcpTaskRegistry.apis.get(api);
        return (
            policies?.methods.get(methodName)?.customizer ??
            policies?.policy.customizer ??
            GcpTaskRegistry.all.customizer
        );
    }

    /** The registered gax CallOptions, method -> API -> ALL, or undefined. */
    // webpieces-disable no-function-outside-class -- process-global registry lookup
    static gaxFor(api: Function, methodName: string): CallOptions | undefined {
        const policies = GcpTaskRegistry.apis.get(api);
        return policies?.methods.get(methodName)?.gax ?? policies?.policy.gax ?? GcpTaskRegistry.all.gax;
    }

    // webpieces-disable no-function-outside-class -- process-global registry reset for tests
    static clear(): void {
        GcpTaskRegistry.all = new GcpTaskPolicy();
        GcpTaskRegistry.apis.clear();
    }

    // webpieces-disable no-function-outside-class -- process-global registry storage
    private static policy(api: Function | 'ALL', methodName?: string): GcpTaskPolicy {
        if (api === 'ALL') {
            return GcpTaskRegistry.all;
        }
        let policies = GcpTaskRegistry.apis.get(api);
        if (!policies) {
            policies = new ApiGcpTaskPolicies();
            GcpTaskRegistry.apis.set(api, policies);
        }
        if (methodName === undefined) return policies.policy;
        let policy = policies.methods.get(methodName);
        if (!policy) {
            policy = new GcpTaskPolicy();
            policies.methods.set(methodName, policy);
        }
        return policy;
    }
}
