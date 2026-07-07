/**
 * ParametersPassedIn - The arguments captured from one mock invocation.
 * Per CLAUDE.md: data-only structure = class.
 */
export class ParametersPassedIn {
    // webpieces-disable no-any-unknown -- mock captures arbitrary api arguments
    constructor(public readonly args: unknown[]) {}
}

/**
 * ValueToReturn - One primed response: either a value supplier or an error
 * supplier (port of Java ValueToReturn).
 */
export class ValueToReturn {
    constructor(
        // webpieces-disable no-any-unknown -- primed values are api-specific, erased here
        private readonly valueSupplier?: () => unknown,
        private readonly errorSupplier?: () => Error,
    ) {}

    /**
     * Resolve the primed entry: throws if primed as an exception, else returns.
     */
    // webpieces-disable no-any-unknown -- primed values are api-specific, erased here
    returnOrThrowValue(): unknown {
        if (this.errorSupplier) {
            throw this.errorSupplier();
        }
        return this.valueSupplier ? this.valueSupplier() : undefined;
    }
}

/**
 * MockHandler - The mock engine (port of Java MockSuperclass), keyed by
 * method name.
 *
 * Semantics identical to Java:
 * - Primed values form a QUEUE per method; each call dequeues one.
 * - Empty queue falls back to the method's default value.
 * - No queue entry and no default -> throws "test did not add enough return values".
 * - getCalledMethodList/getSingleRequestList DRAIN the recorded calls.
 *
 * Usually consumed through createMock<T>() which wraps this in a typed Proxy;
 * use directly only when hand-writing a mock class.
 */
export class MockHandler {
    private returnValues: Map<string, ValueToReturn[]> = new Map();
    private defaultReturnValues: Map<string, ValueToReturn> = new Map();
    private calledMethods: Map<string, ParametersPassedIn[]> = new Map();

    /**
     * Queue a value to return on the next call to method.
     */
    // webpieces-disable no-any-unknown -- primed values are api-specific, erased here
    addValueToReturn(method: string, value: unknown): void {
        this.queueFor(method).push(new ValueToReturn(() => value));
    }

    /**
     * Queue a computed value (supplier runs at call time).
     */
    // webpieces-disable no-any-unknown -- primed values are api-specific, erased here
    addCalculateRetValue(method: string, supplier: () => unknown): void {
        this.queueFor(method).push(new ValueToReturn(supplier));
    }

    /**
     * Queue an exception to throw on the next call to method.
     */
    addExceptionToThrow(method: string, errorSupplier: () => Error): void {
        this.queueFor(method).push(new ValueToReturn(undefined, errorSupplier));
    }

    /**
     * Fallback value returned when the queue for method is empty.
     */
    // webpieces-disable no-any-unknown -- primed values are api-specific, erased here
    setDefaultReturnValue(method: string, value: unknown): void {
        this.defaultReturnValues.set(method, new ValueToReturn(() => value));
    }

    /**
     * Record a call and resolve its response (queue -> default -> throw).
     * Called by the createMock proxy for every api-method invocation.
     */
    // webpieces-disable no-any-unknown -- mock engine handles type-erased calls; createMock adds typing
    calledMethod(method: string, args: unknown[]): unknown {
        const calls = this.calledMethods.get(method) ?? [];
        calls.push(new ParametersPassedIn(args));
        this.calledMethods.set(method, calls);

        const queue = this.returnValues.get(method);
        if (queue && queue.length > 0) {
            const next = queue.shift()!;
            return next.returnOrThrowValue();
        }

        const defaultValue = this.defaultReturnValues.get(method);
        if (defaultValue) {
            return defaultValue.returnOrThrowValue();
        }

        throw new Error(
            `The test did not add enough return values to mocked method '${method}'. ` +
            `Prime it with addValueToReturn('${method}', ...) or setDefaultReturnValue('${method}', ...).`,
        );
    }

    /**
     * DRAIN and return all recorded invocations of method (Java parity: the
     * list resets so a second assertion sees only new calls).
     */
    getCalledMethodList(method: string): ParametersPassedIn[] {
        const calls = this.calledMethods.get(method) ?? [];
        this.calledMethods.delete(method);
        return calls;
    }

    /**
     * DRAIN and return the FIRST argument of each recorded invocation - the
     * common single-request-DTO shape.
     */
    getSingleRequestList<R>(method: string): R[] {
        return this.getCalledMethodList(method).map((p: ParametersPassedIn) => p.args[0] as R);
    }

    /**
     * Reset all primed values, defaults, and recorded calls.
     */
    clear(): void {
        this.returnValues.clear();
        this.defaultReturnValues.clear();
        this.calledMethods.clear();
    }

    private queueFor(method: string): ValueToReturn[] {
        const queue = this.returnValues.get(method) ?? [];
        this.returnValues.set(method, queue);
        return queue;
    }
}
