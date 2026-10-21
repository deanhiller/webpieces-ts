import { Attempt, CallContext, CallStrategy } from './CallStrategy';
import { CallDeadline } from './CallDeadline';
import { TransportDefault } from './TransportDefault';
import { ApiRegistry } from './ApiRegistry';
import { CallOutcome } from './ErrorClassifier';
import { ApiMethodInfo } from './ApiMethodInfo';
import { LogManager } from '../logging/LogManager';
import { LOG_API_CALL_LOGGER_NAME } from './ApiCallLogName';
import { toError } from '../lib/errorUtils';
import { CallScope, CallScopeLadder } from './CallScope';

// The same logger LogApiCall writes its [API-*] lines to, so an attempt line sits beside the final one.
const log = LogManager.getLogger(LOG_API_CALL_LOGGER_NAME);

class CallPolicy {
    timeoutMs?: number;
    // webpieces-disable no-any-unknown -- global policy spans heterogeneous response DTOs
    strategy?: CallStrategy<unknown>;
}

/**
 * Counts the attempts of ONE call and logs each retried TRANSIENT failure. It wraps the attempt
 * BEFORE any strategy sees it, so an app-written strategy gets the same lines as `RetryStrategy`.
 *
 * The line for attempt N is written when attempt N+1 STARTS — i.e. only for an attempt that was
 * actually retried. The last attempt's failure is what escapes, and `LogApiCall`'s final
 * `[API-client-resp-FAIL]` line covers it, so a call that gave up after 4 attempts logs 3 attempt
 * lines and 1 FAIL line, never the last failure twice. An EXPECTED or FAILURE attempt is not logged
 * here either; the final line covers it.
 */
class LoggedAttempts<T> {
    private attempts = 0;
    private pendingTransient?: Error;

    constructor(
        private readonly context: CallContext,
        private readonly attempt: Attempt<T>,
    ) {}

    readonly run: Attempt<T> = async (timeoutMs: number): Promise<T> => {
        this.flushRetried();
        this.attempts += 1;
        // webpieces-disable no-unmanaged-exceptions -- observe the attempt's failure, rethrow it unchanged
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            return await this.attempt(timeoutMs);
        } catch (err: unknown) {
            const error = toError(err);
            const methodInfo = new ApiMethodInfo(
                'client',
                this.context.apiName,
                this.context.methodName,
                this.context.contract,
            );
            this.pendingTransient =
                ApiRegistry.classify(error, methodInfo) === CallOutcome.TRANSIENT_FAILURE
                    ? error
                    : undefined;
            // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- rethrows the attempt's own failure unchanged
            throw err;
        }
    };

    private flushRetried(): void {
        const error = this.pendingTransient;
        if (error === undefined) return;
        this.pendingTransient = undefined;
        log.warn(
            `[API-client-attempt-TRANSIENT] ${this.context.apiName}.${this.context.methodName} ` +
                `attempt ${this.attempts} errorType=${error.constructor.name} error=${error.message}`,
        );
    }
}

/**
 * Derives a base URL for a service name that has NO registered mapping — the pluggable half of
 * {@link ClientRegistry} resolution. One per environment, installed once at startup:
 *
 * - `gcpCloudRunDeriver()` (@webpieces/gcp-identity) — the Cloud Run formula, read from the metadata
 *   server. For code running ON GCP.
 * - `gcpCloudRunDeriver(new GcpCloudRunTarget(projectNumber, region))` — the SAME formula with the
 *   values supplied from config, for code running OFF GCP that still calls Cloud Run (a CLI, CI).
 * - {@link templateDeriver} (this package, browser-safe) — pure string substitution, for AWS or
 *   anything else with predictable DNS.
 * - none at all — a browser goes same-origin, and localhost/tests hand-register their mappings.
 */
export type ServiceUrlDeriver = (svcName: string) => Promise<string>;

/**
 * ClientRegistry - the ONE place a `svcName` becomes a base URL, for every outbound client in every
 * environment. A client is built once but a URL is per-environment, so the URL belongs here rather
 * than on the client: clients carry ONLY a svcName.
 *
 * Resolution is one precedence chain, identical in the browser, in node, and in Cloud Tasks:
 *
 *   1. a registered mapping wins — the localhost port table, AWS, an external API, another region
 *      or project, a host that is not Cloud Run at all. Populated at startup from per-env config.
 *   2. else the installed {@link ServiceUrlDeriver}, if any — GCP's built-in, a DNS template, or
 *      your own. OPTIONAL on purpose: localhost is inherently a TABLE (helper-fsdb -> :8401,
 *      helper-portal -> :8201 have per-service ports), so explicit mappings must stay sufficient on
 *      their own.
 *   3. else the caller's fallback: the BROWSER goes relative (same origin — see
 *      {@link ClientRegistry.tryResolve}), while node THROWS (see {@link ClientRegistry.resolve}),
 *      because a server has no "own origin" and an unresolvable peer is a setup bug.
 *
 * Configured like {@link HeaderRegistry} / LogManager — populated once at startup, then globally
 * accessible with NO DI wiring. It is browser-safe (no `process.env`, no node-only deps), which is
 * why it lives in core-util rather than gcp-identity.
 *
 * A `svcName` should be the nx MODULE name of the service you are calling — that is the one name
 * `architecture:validate-runtime-architecture` can verify actually exists, so a typo or a rename
 * fails the build instead of failing in production. When the DEPLOYED name differs (an environment
 * prefix like `tf-`, or a Cloud Run service named unlike its module), translate it in ONE place —
 * the deriver below, or a `serviceName` alias in the module's project.json — never at the call site.
 *
 * ```ts
 * // startup, from the current environment's config:
 * ClientRegistry.addMapping('server2', 8202);                       // -> http://localhost:8202
 * ClientRegistry.addUrlMapping('email', 'https://email.other-region.example');
 * ClientRegistry.setDeriver(gcpCloudRunDeriver());                  // everything else, on GCP
 * ```
 *
 * The OTHER half: everything ONLY an outbound call reads besides its URL — the per-call timeout and
 * strategy, for browser RPC, node RPC, and Cloud Tasks ENQUEUE. ONE implementation; every transport
 * calls {@link ClientRegistry.execute}. (What BOTH sides read — the error translator and classifier —
 * lives on `ApiRegistry`.)
 *
 * Ladder: strategy method -> API -> ALL first; ANY strategy replaces the ENTIRE timeout ladder.
 * Otherwise timeout method -> API -> ALL. Otherwise the transport's {@link TransportDefault} (its
 * timeout, and its strategy if it has one). A registered TIMEOUT is therefore a decision for a single
 * attempt and also replaces a transport's default strategy; to keep retrying with a different attempt
 * deadline, register a `RetryStrategy` instead.
 *
 * RPC has no default retry (only the application knows whether repeating a POST is safe); Cloud Tasks
 * enqueue does (see `TransportDefault`). An app opts RPC in with
 * `ClientRegistry.setStrategy(new RetryStrategy(...).run, CallScope.api(CatalogApi))` — and `RetryStrategy` never
 * retries a `WRITE`, even registered at ALL.
 */
export class ClientRegistry {
    /** svcName -> resolved base URL. Process-global; populated at startup per environment. */
    private static readonly mappings = new Map<string, string>();

    /** The fallback for svcNames with no mapping. Undefined = no derivation in this environment. */
    private static deriver: ServiceUrlDeriver | undefined;

    /** The timeout / strategy per {@link CallScope} — method -> API -> ALL -> the transport default. */
    private static readonly policies = new CallScopeLadder<CallPolicy>(() => new CallPolicy());

    /** Map a service name to `http://localhost:<port>`. */
    // webpieces-disable no-function-outside-class -- static global singleton (like HeaderRegistry/LogManager); populated once at startup, never DI-injected
    static addMapping(svcName: string, port: number): void {
        ClientRegistry.mappings.set(svcName, `http://localhost:${port}`);
    }

    /**
     * Map a service name to an explicit base URL (any host / any environment).
     *
     * The EMPTY STRING is a legal, meaningful mapping: it makes the service relative, i.e.
     * same-origin, because the client builds its URL as `${baseUrl}${route.path}`.
     */
    // webpieces-disable no-function-outside-class -- static global singleton (like HeaderRegistry/LogManager); populated once at startup, never DI-injected
    static addUrlMapping(svcName: string, url: string): void {
        ClientRegistry.mappings.set(svcName, url);
    }

    /**
     * Install the environment's {@link ServiceUrlDeriver} — how to resolve a svcName that has NO
     * mapping. Optional: an environment that registers every svcName it calls needs none.
     */
    // webpieces-disable no-function-outside-class -- static global singleton (like HeaderRegistry/LogManager); populated once at startup, never DI-injected
    static setDeriver(fn: ServiceUrlDeriver): void {
        ClientRegistry.deriver = fn;
    }

    /** The registered override for `svcName`, or undefined if none. Registry only — no derivation. */
    // webpieces-disable no-function-outside-class -- static global singleton (like HeaderRegistry/LogManager); populated once at startup, never DI-injected
    static tryLookup(svcName: string): string | undefined {
        return ClientRegistry.mappings.get(svcName);
    }

    /**
     * Resolve `svcName` to its registered base URL. THROWS if the service was never registered.
     * Registry only — it does NOT consult the deriver; prefer {@link ClientRegistry.resolve}.
     */
    // webpieces-disable no-function-outside-class -- static global singleton (like HeaderRegistry/LogManager); populated once at startup, never DI-injected
    static lookup(svcName: string): string {
        const url = ClientRegistry.tryLookup(svcName);
        if (url === undefined) {
            throw new Error(
                `No URL registered for service "${svcName}". Register it at startup: ` +
                    `ClientRegistry.addMapping(svcName, port) for a localhost port, or ` +
                    `ClientRegistry.addUrlMapping(svcName, url) for an explicit URL.`,
            );
        }
        return url;
    }

    /**
     * Steps 1 + 2 of the chain: the registered mapping, else the installed deriver, else undefined.
     * Non-throwing — the BROWSER uses this and treats undefined as "" (relative → same origin),
     * which is what a browser app calling the backend it was served from wants by default.
     *
     * Note the `!== undefined` guard: an empty-string mapping is a legal answer ("this service is
     * same-origin"), so it must NOT fall through to derivation.
     */
    // webpieces-disable no-function-outside-class -- static global singleton (like HeaderRegistry/LogManager); populated once at startup, never DI-injected
    static tryResolve(svcName: string): Promise<string | undefined> {
        const override = ClientRegistry.tryLookup(svcName);
        if (override !== undefined) {
            return Promise.resolve(override);
        }
        if (!ClientRegistry.deriver) {
            return Promise.resolve(undefined);
        }
        return ClientRegistry.deriver(svcName);
    }

    /**
     * The full chain, with node's fallback: mapping, else deriver, else THROW. A server has no "own
     * origin" to go relative to, so an unresolvable peer is a setup bug and must fail loudly — and
     * say how to fix it.
     */
    // webpieces-disable no-function-outside-class -- static global singleton (like HeaderRegistry/LogManager); populated once at startup, never DI-injected
    static async resolve(svcName: string): Promise<string> {
        const url = await ClientRegistry.tryResolve(svcName);
        if (url === undefined) {
            throw new Error(
                `No URL for service "${svcName}".\n` +
                    `  - localhost/AWS: ClientRegistry.addMapping('${svcName}', 8401)\n` +
                    `                or ClientRegistry.addUrlMapping('${svcName}', 'https://...')\n` +
                    `  - GCP: install a deriver — ClientRegistry.setDeriver(gcpCloudRunDeriver())\n` +
                    `  - deployed name differs from the module name (e.g. a 'tf-' prefix)? Translate it ONCE\n` +
                    `    in the deriver — setDeriver(s => gcpCloudRunDeriver()('tf-' + s)) — so every call\n` +
                    `    site keeps naming the MODULE, which architecture:validate-runtime-architecture checks`,
            );
        }
        return url;
    }

    // webpieces-disable no-function-outside-class -- process-global startup registry
    static setTimeout(timeoutMs: number | undefined, scope: CallScope): void {
        if (timeoutMs !== undefined) CallDeadline.validate(timeoutMs);
        ClientRegistry.policies.at(scope).timeoutMs = timeoutMs;
    }

    // webpieces-disable no-function-outside-class -- process-global startup registry
    static setStrategy(
        // webpieces-disable no-any-unknown -- registry strategies span heterogeneous response DTOs
        strategy: CallStrategy<unknown> | undefined,
        scope: CallScope,
    ): void {
        ClientRegistry.policies.at(scope).strategy = strategy;
    }

    /**
     * Run one call under its registered policy. `context` names the method (its `methodName` selects
     * the per-method policy) and carries the endpoint's declared operation, so the SAME context a
     * strategy sees is the one the transport's deadline puts on an `ApiCallTimeoutError`. The context
     * a strategy sees always carries `api` as its {@link CallContext.contract}, so the error
     * classification inside a strategy resolves on the same ladder.
     *
     * Every attempt is wrapped so a retried TRANSIENT failure logs one
     * `WARN [API-client-attempt-TRANSIENT]` line (see {@link LoggedAttempts}).
     */
    // webpieces-disable no-function-outside-class -- transport-independent policy execution
    static async execute<T>(
        api: Function,
        context: CallContext,
        attempt: Attempt<T>,
        fallback: TransportDefault,
    ): Promise<T> {
        const scoped =
            context.contract === api
                ? context
                : new CallContext(context.apiName, context.methodName, context.operation, api);
        const logged = new LoggedAttempts<T>(scoped, attempt).run;
        const rungs = ClientRegistry.policies.rungs(api, scoped.methodName);
        const strategy = rungs.find((p: CallPolicy) => p.strategy !== undefined)?.strategy;
        if (strategy !== undefined) {
            return (await strategy(logged, scoped)) as T;
        }
        const timeoutMs = rungs.find((p: CallPolicy) => p.timeoutMs !== undefined)?.timeoutMs;
        if (timeoutMs !== undefined) {
            return logged(timeoutMs);
        }
        if (fallback.strategy !== undefined) {
            return (await fallback.strategy(logged, scoped)) as T;
        }
        return logged(fallback.timeoutMs);
    }

    /**
     * The registered TIMEOUT for a call — method -> API -> ALL -> `defaultMs` — ignoring every
     * strategy. For a transport that hands timing to someone else for this call (Cloud Tasks enqueue
     * with caller-supplied gax `CallOptions`) and still needs ONE safety cap so a hung channel cannot
     * block forever. Raise it with {@link ClientRegistry.setTimeout}.
     */
    // webpieces-disable no-function-outside-class -- process-global registry lookup
    static resolveTimeout(api: Function, methodName: string, defaultMs: number): number {
        const rungs = ClientRegistry.policies.rungs(api, methodName);
        return rungs.find((p: CallPolicy) => p.timeoutMs !== undefined)?.timeoutMs ?? defaultMs;
    }

    /**
     * Put the process-globals back to the state a fresh process starts in. For TESTS, so one spec
     * cannot leak its registrations into the next: every URL mapping, the deriver, and every
     * timeout / strategy rung. (`ApiRegistry.resetForTests()` resets the error translators and
     * classifiers.)
     */
    // webpieces-disable no-function-outside-class -- static global singleton (like HeaderRegistry/LogManager); populated once at startup, never DI-injected
    static resetForTests(): void {
        ClientRegistry.mappings.clear();
        ClientRegistry.deriver = undefined;
        ClientRegistry.policies.clear();
    }
}
