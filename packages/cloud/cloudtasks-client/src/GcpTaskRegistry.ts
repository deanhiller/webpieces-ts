import type { CallOptions } from 'google-gax';
import { CallScopeLadder } from '@webpieces/core-util';
import type { CallScope } from '@webpieces/core-util';
import { TaskCustomizer } from './TaskTypes';

class GcpTaskPolicy {
    customizer?: TaskCustomizer;
    gax?: CallOptions;
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
    private static readonly ladder = new CallScopeLadder<GcpTaskPolicy>(() => new GcpTaskPolicy());

    // webpieces-disable no-function-outside-class -- process-global startup registry
    static setCustomizer(customizer: TaskCustomizer | undefined, ...scope: CallScope): void {
        GcpTaskRegistry.ladder.at(...scope).customizer = customizer;
    }

    // webpieces-disable no-function-outside-class -- process-global startup registry
    static setGax(gax: CallOptions | undefined, ...scope: CallScope): void {
        GcpTaskRegistry.ladder.at(...scope).gax = gax;
    }

    /** The registered customizer, method -> API -> ALL, or undefined. */
    // webpieces-disable no-function-outside-class -- process-global registry lookup
    static customizerFor(api: Function, methodName: string): TaskCustomizer | undefined {
        return GcpTaskRegistry.ladder
            .rungs(api, methodName)
            .find((p: GcpTaskPolicy) => p.customizer !== undefined)?.customizer;
    }

    /** The registered gax CallOptions, method -> API -> ALL, or undefined. */
    // webpieces-disable no-function-outside-class -- process-global registry lookup
    static gaxFor(api: Function, methodName: string): CallOptions | undefined {
        return GcpTaskRegistry.ladder.rungs(api, methodName).find((p: GcpTaskPolicy) => p.gax !== undefined)?.gax;
    }

    // webpieces-disable no-function-outside-class -- process-global registry reset for tests
    static clear(): void {
        GcpTaskRegistry.ladder.clear();
    }
}
