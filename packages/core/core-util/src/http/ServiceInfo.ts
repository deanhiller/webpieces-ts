/**
 * ServiceInfo - the ONE answer to "what service am I, and which build of it?", for every part of
 * webpieces that needs it.
 *
 * Configured like {@link HeaderRegistry} / {@link ClientRegistry} / LogManager — populated once at
 * startup, then globally accessible with NO DI wiring. Browser-safe (no `process.env`, no node-only
 * deps), which is why it lives in core-util beside {@link ClientRegistry}.
 *
 * ```ts
 * // startup, FIRST — before the logger factory is constructed (it reads this):
 * ServiceInfo.setInfo('my-service', '2.1.0');
 * ```
 *
 * WHY THIS EXISTS. Both facts used to be artifacts of WHICH LOGGING LIBRARY YOU PICKED rather than
 * facts about the service:
 * - the name lived on `BunyanFactoryOptions`, because bunyan REQUIRES a root-logger name
 *   (`options.name (string) is required` — bunyan's own TypeError). winston has no such concept, so
 *   a winston app shipped its logs UNNAMED.
 * - the version lived on `WinstonFactoryOptions` as `svcGitHash`, so a bunyan app could not stamp a
 *   version AT ALL — and the name presumed a git SHA, which not every project deploys from.
 *
 * Switching backends silently changed which fields your logs carried. Several unrelated readers
 * need these same two facts, so they belong to the framework, not to a backend:
 * - the bunyan backend, to satisfy bunyan's mandatory root-logger `name`, and to stamp `version`;
 * - the winston backend, to stamp `svcName` + `version`;
 * - {@link WebpiecesCoreHeaders.REQUEST_ID_SOURCE}, to record WHO minted a request id.
 *
 * VERSION IS OPAQUE. It is whatever string identifies THIS build — a git SHA, a semver tag, a CI
 * build number. webpieces neither parses nor derives it; the app decides where it comes from (a
 * generated file, an env var, a Docker build arg) and passes it here.
 *
 * FAIL FAST, AT STARTUP. {@link getName} / {@link getVersion} throw, and the logger factories +
 * `setupRuntime` call them while the process is booting — so a forgotten `setInfo` kills the deploy
 * (the revision never goes healthy) instead of quietly shipping logs that cannot say which build
 * emitted them. Nothing on the REQUEST path may throw over this: a missing log field must never 500
 * live traffic, so per-request readers use {@link tryGetName} / {@link tryGetVersion} and simply
 * omit the field.
 */
export class ServiceInfo {
    /** This service's name. Process-global; set once at startup. */
    private static svcName: string | undefined;

    /** This build's version — an opaque app-chosen string. Process-global; set once at startup. */
    private static svcVersion: string | undefined;

    /**
     * Identify this service. Call it FIRST at startup — before constructing the logger factory,
     * which reads both values during its own constructor.
     *
     * LAST CALL WINS, deliberately. A real deployment identifies itself once, but an in-process test
     * can legitimately boot TWO services back-to-back (see the app-example e2e two-server flow), so a
     * "one process = one service" rule would reject a case that genuinely exists. Since a logger
     * factory captures both values in its own constructor, each server built that way still keeps
     * what was set when IT was built.
     *
     * @param name - this service's name, e.g. 'my-service'.
     * @param version - the opaque identifier of THIS build (git SHA, semver, CI build number).
     * @throws Error on a blank name or version — that is always a bug, never a use case.
     */
    // webpieces-disable no-function-outside-class -- static global singleton (like HeaderRegistry/ClientRegistry); populated once at startup, never DI-injected
    static setInfo(name: string, version: string): void {
        if (!name || !name.trim()) {
            throw new Error('ServiceInfo.setInfo(...) requires a non-blank service name.');
        }
        if (!version || !version.trim()) {
            throw new Error(
                'ServiceInfo.setInfo(...) requires a non-blank version. It is opaque to webpieces — ' +
                'a git SHA, a semver tag, a CI build number — but every deployed build must be able ' +
                'to say which build it is.',
            );
        }
        ServiceInfo.svcName = name;
        ServiceInfo.svcVersion = version;
    }

    /**
     * This service's name, REQUIRED. For STARTUP callers only (the logger factories, setupRuntime) —
     * they run while booting, so throwing here fails the deploy rather than live traffic.
     *
     * @throws Error if {@link setInfo} was never called.
     */
    // webpieces-disable no-function-outside-class -- static global singleton (like HeaderRegistry/ClientRegistry); populated once at startup, never DI-injected
    static getName(): string {
        if (!ServiceInfo.svcName) {
            throw new Error(ServiceInfo.notSetMessage());
        }
        return ServiceInfo.svcName;
    }

    /**
     * This build's version, REQUIRED. For STARTUP callers only (the logger factories, setupRuntime),
     * for the same reason as {@link getName}.
     *
     * @throws Error if {@link setInfo} was never called.
     */
    // webpieces-disable no-function-outside-class -- static global singleton (like HeaderRegistry/ClientRegistry); populated once at startup, never DI-injected
    static getVersion(): string {
        if (!ServiceInfo.svcVersion) {
            throw new Error(ServiceInfo.notSetMessage());
        }
        return ServiceInfo.svcVersion;
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

    /**
     * This build's version, or undefined when unset. For the REQUEST path, which must NOT throw —
     * same reasoning as {@link tryGetName}.
     */
    // webpieces-disable no-function-outside-class -- static global singleton (like HeaderRegistry/ClientRegistry); populated once at startup, never DI-injected
    static tryGetVersion(): string | undefined {
        return ServiceInfo.svcVersion;
    }

    /** Reset — for tests, mirroring {@link ClientRegistry.clear}. */
    // webpieces-disable no-function-outside-class -- static global singleton (like HeaderRegistry/ClientRegistry); populated once at startup, never DI-injected
    static clear(): void {
        ServiceInfo.svcName = undefined;
        ServiceInfo.svcVersion = undefined;
    }

    /**
     * The one actionable "you forgot to call setInfo" message. Shared by {@link getName} and
     * {@link getVersion}: setInfo sets BOTH, so either being missing has the identical cause and
     * the identical fix — telling the caller only about the half they happened to read first would
     * send them back for a second round.
     */
    // webpieces-disable no-function-outside-class -- static global singleton (like HeaderRegistry/ClientRegistry); populated once at startup, never DI-injected
    private static notSetMessage(): string {
        return (
            'ServiceInfo.setInfo(...) has not been called. Identify this service at startup, ' +
            'BEFORE constructing the logger factory (it reads name+version in its constructor):\n' +
            "    ServiceInfo.setInfo('my-service', '2.1.0');\n" +
            'The name+version stamp every log line (so you can tell WHICH BUILD emitted a line), ' +
            'and the name records which service minted a request id (requestIdSource). The version ' +
            'is opaque — a git SHA, a semver tag, a CI build number, whatever identifies your build.'
        );
    }
}
