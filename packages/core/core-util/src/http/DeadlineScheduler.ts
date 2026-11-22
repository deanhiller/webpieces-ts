/**
 * One scheduled deadline. {@link CallDeadline} calls {@link cancel} EXACTLY ONCE per call, on every
 * settlement — success, failure, abort or the deadline itself firing — so an implementation may
 * release its native timer there without guarding against a second call.
 */
export interface DeadlineTimer {
    cancel(): void;
}

/**
 * Where a call deadline's clock and wake-up come from (#1445). The ONE timing seam of the generated
 * clients: {@link CallDeadline} schedules each attempt's deadline through it, and `RetryStrategy`
 * waits out its backoff through it, so nothing on the call path reaches for a JS timer behind it.
 *
 * - Browser, Node, SSR, workers and tests: {@link TimerDeadlineScheduler} — standard
 *   `setTimeout` / `clearTimeout`, which is what every call used before this seam existed.
 * - React Native: the APPLICATION supplies a native-backed implementation (an AlarmManager /
 *   Handler / DispatchSourceTimer behind a native module, say). React Native's JS timer manager
 *   pauses while the host is paused, so a JS-timer deadline does not fire while an Android phone is
 *   locked; a native-delivered callback does. Wrapping `setTimeout` again does NOT satisfy this
 *   contract — the scheduler exists precisely so the wake-up does not come from a JS timer.
 *
 * Implementation contract:
 * - `schedule` may throw synchronously (the call then fails before any work starts, and nothing is
 *   scheduled to clean up).
 * - `onExpire` may be delivered LATE, after the call already settled, or not at all while the OS has
 *   the process suspended. A late delivery is ignored; no delivery is covered by {@link now}: when the
 *   work settles and `now()` shows the budget is spent, the call is failed with the same typed
 *   timeout instead of returning a result that arrived after its deadline.
 * - `now` is a millisecond clock used only for elapsed-time arithmetic. Prefer a monotonic clock that
 *   KEEPS COUNTING while the device sleeps (Android `SystemClock.elapsedRealtime`, for example), or
 *   `Date.now()` as a non-monotonic fallback. A clock that stops during sleep under-reports elapsed
 *   time and lets an expired call return late.
 */
export interface DeadlineScheduler {
    /** Arrange for `onExpire` to run once, `delayMs` from now. */
    schedule(delayMs: number, onExpire: () => void): DeadlineTimer;

    /** Milliseconds on this scheduler's clock; only differences between two readings are meaningful. */
    now(): number;
}

/** A `setTimeout` handle, released through `clearTimeout`. */
class JsTimer implements DeadlineTimer {
    constructor(private readonly handle: ReturnType<typeof setTimeout>) {}

    cancel(): void {
        clearTimeout(this.handle);
    }
}

/**
 * The default {@link DeadlineScheduler} for browsers, WebView pages, Node, SSR, workers and tests:
 * standard JS timers, exactly as every generated client used before #1445 made timing injectable.
 *
 * NOT a React Native background fix — see {@link DeadlineScheduler}. Browsers also throttle timers in
 * background tabs; that is the platform's documented behavior and this class does not fight it.
 */
export class TimerDeadlineScheduler implements DeadlineScheduler {
    schedule(delayMs: number, onExpire: () => void): DeadlineTimer {
        return new JsTimer(setTimeout(onExpire, delayMs));
    }

    now(): number {
        // `performance` is monotonic where it exists (browsers, Node 16+, React Native); a runtime
        // without it still gets a usable — if adjustable — wall clock.
        return typeof performance !== 'undefined' ? performance.now() : Date.now();
    }
}
