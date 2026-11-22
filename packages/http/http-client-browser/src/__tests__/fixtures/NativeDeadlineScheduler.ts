import { DeadlineScheduler, DeadlineTimer } from '@webpieces/core-util';

/**
 * The integration EXAMPLE for #1445: what a React Native app's native timer module looks like from
 * JavaScript, and the {@link DeadlineScheduler} adapter over it. webpieces ships neither — an app
 * owns its native module (Kotlin `Handler`/`AlarmManager`, Swift `DispatchSourceTimer`) — but the
 * README's setup section is this file, and the runtime spec drives it exactly as the app would.
 *
 * The native module only needs three bridge calls and one event:
 * - `start(id, delayMs)` arms a native timer;
 * - `cancel(id)` disarms it (a timer that already fired is a no-op);
 * - `elapsedRealtimeMs()` reads a clock that keeps counting while the device sleeps
 *   (Android `SystemClock.elapsedRealtime()`), synchronously (a JSI/TurboModule sync method);
 * - when a timer fires, native emits an event the app forwards to {@link NativeDeadlineScheduler.deliver}.
 */
export interface NativeTimerModule {
    start(id: number, delayMs: number): void;
    cancel(id: number): void;
    elapsedRealtimeMs(): number;
}

class NativeDeadline implements DeadlineTimer {
    constructor(
        private readonly id: number,
        private readonly scheduler: NativeDeadlineScheduler,
    ) {}

    cancel(): void {
        this.scheduler.release(this.id);
    }
}

/**
 * The adapter. Wire its {@link deliver} to the native event once at startup, e.g.
 * `emitter.addListener('deadlineFired', (e) => scheduler.deliver(e.id))`, then hand the scheduler to
 * `HttpClientRuntime.reactNative(expoFetch, scheduler)` for EVERY React Native client factory.
 */
export class NativeDeadlineScheduler implements DeadlineScheduler {
    private nextId = 1;
    private readonly pending = new Map<number, () => void>();

    constructor(private readonly native: NativeTimerModule) {}

    schedule(delayMs: number, onExpire: () => void): DeadlineTimer {
        const id = this.nextId++;
        this.pending.set(id, onExpire);
        this.native.start(id, delayMs);
        return new NativeDeadline(id, this);
    }

    now(): number {
        return this.native.elapsedRealtimeMs();
    }

    /** Called from the native event. A delivery for a released id (it raced a cancel) is dropped. */
    deliver(id: number): void {
        const onExpire = this.pending.get(id);
        if (onExpire === undefined) return;
        this.pending.delete(id);
        onExpire();
    }

    release(id: number): void {
        if (!this.pending.delete(id)) return;
        this.native.cancel(id);
    }
}

/** One native timer the fake module was asked to arm. */
export class NativeStart {
    constructor(
        readonly id: number,
        readonly delayMs: number,
    ) {}
}

/** The EDGE double: a native module whose timers fire only when the test says so. */
export class FakeNativeTimerModule implements NativeTimerModule {
    readonly starts: NativeStart[] = [];
    readonly cancels: number[] = [];
    clockMs = 1_000;

    start(id: number, delayMs: number): void {
        this.starts.push(new NativeStart(id, delayMs));
    }

    cancel(id: number): void {
        this.cancels.push(id);
    }

    elapsedRealtimeMs(): number {
        return this.clockMs;
    }
}

/** One deadline a {@link ManualDeadlines} was asked to schedule, with everything the test needs. */
export class ManualDeadline implements DeadlineTimer {
    cancelCount = 0;

    constructor(
        readonly delayMs: number,
        /** Invoke at any time — including AFTER the call settled, to model a late native delivery. */
        readonly fire: () => void,
    ) {}

    cancel(): void {
        this.cancelCount++;
    }
}

/** A scheduler that never fires on its own and never drops a late callback: the race-test edge. */
export class ManualDeadlines implements DeadlineScheduler {
    readonly scheduled: ManualDeadline[] = [];
    clockMs = 0;
    failNextSchedule: Error | undefined;

    schedule(delayMs: number, onExpire: () => void): DeadlineTimer {
        const failure = this.failNextSchedule;
        if (failure !== undefined) {
            this.failNextSchedule = undefined;
            throw failure;
        }
        const deadline = new ManualDeadline(delayMs, onExpire);
        this.scheduled.push(deadline);
        return deadline;
    }

    now(): number {
        return this.clockMs;
    }
}
