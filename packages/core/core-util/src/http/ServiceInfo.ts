/**
 * ServiceInfo - the ONE answer to "what service am I?", for every part of webpieces that needs it.
 *
 * Configured like {@link HeaderRegistry} / {@link ClientRegistry} / LogManager — populated once at
 * startup, then globally accessible with NO DI wiring. Browser-safe (no `process.env`, no node-only
 * deps), which is why it lives in core-util beside {@link ClientRegistry}.
 *
 * ```ts
 * // startup, FIRST — before the logger factory is constructed (it reads this):
 * ServiceInfo.setName('my-service');
 * ```
 *
 * WHY THIS EXISTS. The name used to live on `BunyanFactoryOptions`, which made it an artifact of
 * WHICH LOGGING LIBRARY YOU PICKED rather than a fact about the service:
 * - bunyan REQUIRES a root-logger name (`options.name (string) is required` — bunyan's own
 *   TypeError), so a bunyan app was forced to supply one.
 * - winston has no such concept, so a winston app supplied nothing and shipped its logs UNNAMED.
 *
 * Three unrelated readers need the same fact, so it belongs to the framework, not to a backend:
 * - the bunyan backend, to satisfy bunyan's mandatory root-logger `name`;
 * - the winston backend, to stamp `svcName` (which it never had);
 * - {@link WebpiecesCoreHeaders.REQUEST_ID_SOURCE}, to record WHO minted a request id.
 *
 * FAIL FAST, AT STARTUP. {@link getName} throws, and the logger factories + `setupRuntime` call it
 * while the process is booting — so a forgotten `setName` kills the deploy (the revision never goes
 * healthy) instead of quietly shipping unnamed logs. Nothing on the REQUEST path may throw over
 * this: a missing log field must never 500 live traffic, so per-request readers use
 * {@link tryGetName} and simply omit the field. See {@link tryGetName}.
 */
export class ServiceInfo {
    /** This service's name. Process-global; set once at startup. */
    private static svcName: string | undefined;

    /**
     * Name this service. Call it FIRST at startup — before constructing the logger factory, which
     * reads it during its own constructor.
     *
     * LAST CALL WINS, deliberately. A real deployment names itself once, but an in-process test can
     * legitimately boot TWO services back-to-back (see the app-example e2e two-server flow), so a
     * "one process = one name" rule would reject a case that genuinely exists. Since a logger
     * factory captures the name in its own constructor, each server built that way still keeps the
     * name that was set when IT was built.
     *
     * @throws Error on a blank name — that is always a bug, never a use case.
     */
    // webpieces-disable no-function-outside-class -- static global singleton (like HeaderRegistry/ClientRegistry); populated once at startup, never DI-injected
    static setName(name: string): void {
        if (!name || !name.trim()) {
            throw new Error('ServiceInfo.setName(...) requires a non-blank service name.');
        }
        ServiceInfo.svcName = name;
    }

    /**
     * This service's name, REQUIRED. For STARTUP callers only (the logger factories, setupRuntime) —
     * they run while booting, so throwing here fails the deploy rather than live traffic.
     *
     * @throws Error if {@link setName} was never called.
     */
    // webpieces-disable no-function-outside-class -- static global singleton (like HeaderRegistry/ClientRegistry); populated once at startup, never DI-injected
    static getName(): string {
        if (!ServiceInfo.svcName) {
            throw new Error(
                'ServiceInfo.setName(...) has not been called. Name this service at startup, ' +
                'BEFORE constructing the logger factory (it reads the name in its constructor):\n' +
                "    ServiceInfo.setName('my-service');\n" +
                'It names every log line and records which service minted a request id ' +
                '(requestIdSource).',
            );
        }
        return ServiceInfo.svcName;
    }

    /**
     * This service's name, or undefined when unset. For the REQUEST path, which must NOT throw: a
     * server that booted has already passed the {@link getName} check in `setupRuntime`, so a real
     * request always finds a name here. Only a unit test driving the context directly can see
     * undefined — and there, omitting a log field beats exploding.
     */
    // webpieces-disable no-function-outside-class -- static global singleton (like HeaderRegistry/ClientRegistry); populated once at startup, never DI-injected
    static tryGetName(): string | undefined {
        return ServiceInfo.svcName;
    }

    /** Reset — for tests, mirroring {@link ClientRegistry.clear}. */
    // webpieces-disable no-function-outside-class -- static global singleton (like HeaderRegistry/ClientRegistry); populated once at startup, never DI-injected
    static clear(): void {
        ServiceInfo.svcName = undefined;
    }
}
