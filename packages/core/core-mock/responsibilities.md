# Responsibilities — core-mock

Typed mock framework for feature tests (port of Java webpieces MockSuperclass). `createMock<T>()` returns a Proxy implementing any api plus a `.mock` control facade for the prime/assert vocabulary; `MockHandler` is the underlying queue/default/drain engine.

## In Scope

- `createMock<T>(name)` — Proxy-based typed mock of an api interface/abstract class.
- `MockHandler` — the engine keyed by method name: prime queues, per-method defaults, recorded-call draining.
- Priming: `addValueToReturn`, `addCalculateRetValue`, `addExceptionToThrow`, `setDefaultReturnValue`.
- Assertion: `getCalledMethodList`, `getSingleRequestList`, `clear`.
- Data structures `ValueToReturn` and `ParametersPassedIn`.

## Out of Scope

- DI container rebinding — the test's own container/`rebind` wires the mock in.
- Test runner/assertion library (Jest/expect) — provided by the consuming test.
- Real api implementations or transports — this only fakes them.

## Notes (optional)

Java-parity semantics: primed values form a per-method queue (each call dequeues one); empty queue falls back to the default, else throws "test did not add enough return values"; `getCalledMethodList`/`getSingleRequestList` DRAIN recorded calls so a second assert sees only new ones. Every mocked method returns a Promise.
