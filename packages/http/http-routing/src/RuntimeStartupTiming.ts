import { toError } from '@webpieces/core-util';

/** Startup operations; durations are inclusive, so nested operations must not be added together. */
export enum RuntimeStartupPhase {
    HEADERS = 'headers',
    LOGGING = 'logging',
    WIRING = 'wiring',
    CONTAINER = 'container',
    FRAMEWORK_DI = 'framework-di',
    APPLICATION_DI = 'application-di',
    BIND_MODULE = 'binding-module',
    FIXED_FILTERS = 'fixed-filters',
    FILTER = 'filter-resolution',
    ROUTE_MODULE = 'route-module',
    ROUTES = 'route-registration',
    CONTROLLER = 'controller-resolution',
}

/** Code identity only: never configuration, credentials, request data or exception payloads. */
export class RuntimeStartupOperation {
    constructor(
        public readonly phase: RuntimeStartupPhase,
        public readonly name: string,
    ) {}
}

/** The host owns the monotonic clock/output and closes each started span exactly once. */
export interface RuntimeStartupSpan {
    success(): void;
    failure(): void;
}

/**
 * Optional startup-only diagnostics. Start/finish use the host's clock, so timing requires no SDK.
 * A controller-resolution event measures container.get, including dependencies and singleton reuse;
 * it does not assert that a new controller was constructed. Normal API calls emit no events.
 */
export interface RuntimeStartupObserver {
    start(operation: RuntimeStartupOperation): RuntimeStartupSpan;
}

/** Internal operation boundary. With no observer it creates no timing records and reads no clock. */
export class RuntimeStartupTiming {
    private disabled = false;

    constructor(private readonly observer?: RuntimeStartupObserver) {}

    run<T>(phase: RuntimeStartupPhase, name: string, operation: () => T): T {
        const span = this.begin(phase, name);
        let succeeded = false;
        try {
            const result = operation();
            succeeded = true;
            return result;
        } finally {
            this.finish(span, succeeded);
        }
    }

    async runAsync<T>(
        phase: RuntimeStartupPhase,
        name: string,
        operation: () => T | Promise<T>,
    ): Promise<T> {
        const span = this.begin(phase, name);
        let succeeded = false;
        try {
            const result = await operation();
            succeeded = true;
            return result;
        } finally {
            this.finish(span, succeeded);
        }
    }

    private begin(phase: RuntimeStartupPhase, name: string): RuntimeStartupSpan | undefined {
        if (!this.observer || this.disabled) return undefined;
        // webpieces-disable no-unmanaged-exceptions -- an optional observer must not replace startup's result/error; disable it with a bounded bootstrap diagnostic
        try {
            return this.observer.start(new RuntimeStartupOperation(phase, name));
        } catch (err: unknown) {
            const error = toError(err);
            this.disable(error);
            return undefined;
        }
    }

    private finish(span: RuntimeStartupSpan | undefined, succeeded: boolean): void {
        if (!span || this.disabled) return;
        // webpieces-disable no-unmanaged-exceptions -- preserve the application's original exception even if diagnostic output fails
        try {
            if (succeeded) span.success();
            else span.failure();
        } catch (err: unknown) {
            const error = toError(err);
            this.disable(error);
        }
    }

    private disable(error: Error): void {
        this.disabled = true;
        // Headers/logging may not exist yet. Never initialize a logger/SDK to report its observer.
        console.warn('[startup] timing observer disabled after failure', error);
    }
}
