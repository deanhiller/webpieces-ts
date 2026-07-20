/**
 * ServiceInfo - the ONE answer to "what service am I, and which build of it?", for every part of
 * webpieces that needs it.
 *
 * Configured like {@link HeaderRegistry} / {@link ClientRegistry} / LogManager — populated once at
 * startup, then globally accessible with NO DI wiring. Browser-safe (no `process.env`, no node-only
 * deps), which is why it lives in core-util beside {@link ClientRegistry}.
 *
 * ```ts
 * // startup, FIRST:
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
 * - the winston backend, to stamp `svcName` + `version`;
 * - the bunyan backend, to stamp `version` (its root-logger `name` is a fixed constant now);
 * - {@link WebpiecesCoreHeaders.REQUEST_ID_SOURCE}, to record WHO minted a request id;
 * - {@link WebpiecesCoreHeaders.CLIENT_VERSION}, so a downstream server can log which build called it.
 *
 * VERSION IS OPAQUE. It is whatever string identifies THIS build — a git SHA, a semver tag, a CI
 * build number. webpieces neither parses nor derives it; the app decides where it comes from (a
 * generated file, an env var, a Docker build arg) and passes it here.
 *
 * DOES NOT THROW ON READ. {@link getName} / {@link getVersion} return `undefined` when unset, so a
 * log line emitted before `setInfo` (early boot) still ships — it simply omits the version. Logging
 * never blocks on identity. The "a deployed build MUST identify itself" guarantee is enforced ONCE,
 * loudly, at startup by whoever calls {@link setInfo} — `setupRuntime` takes name+version as REQUIRED
 * inputs and calls it, so a blank value throws and kills the deploy — instead of every reader throwing.
 */
export class ServiceInfo {
    /** This service's name. Process-global; set once at startup. */
    private static svcName: string | undefined;

    /** This build's version — an opaque app-chosen string. Process-global; set once at startup. */
    private static svcVersion: string | undefined;

    /**
     * Identify this service. Call it at startup.
     *
     * LAST CALL WINS, deliberately. A real deployment identifies itself once, but an in-process test
     * can legitimately boot TWO services back-to-back (see the app-example e2e two-server flow), so a
     * "one process = one service" rule would reject a case that genuinely exists.
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
     * This service's name, or `undefined` when {@link setInfo} has not been called. Does NOT throw:
     * readers (logging backends, requestIdSource, outbound CLIENT_VERSION) simply omit the field when
     * it is missing, so a pre-`setInfo` log line still emits. Identity is REQUIRED where it matters —
     * `setupRuntime` takes name+version and calls {@link setInfo} at startup, so a real server is
     * always identified before it serves traffic.
     */
    // webpieces-disable no-function-outside-class -- static global singleton (like HeaderRegistry/ClientRegistry); populated once at startup, never DI-injected
    static getName(): string | undefined {
        return ServiceInfo.svcName;
    }

    /**
     * This build's version, or `undefined` when unset — same non-throwing contract as {@link getName}.
     */
    // webpieces-disable no-function-outside-class -- static global singleton (like HeaderRegistry/ClientRegistry); populated once at startup, never DI-injected
    static getVersion(): string | undefined {
        return ServiceInfo.svcVersion;
    }

    /** Reset — for tests, mirroring {@link ClientRegistry.clear}. */
    // webpieces-disable no-function-outside-class -- static global singleton (like HeaderRegistry/ClientRegistry); populated once at startup, never DI-injected
    static clear(): void {
        ServiceInfo.svcName = undefined;
        ServiceInfo.svcVersion = undefined;
    }
}
