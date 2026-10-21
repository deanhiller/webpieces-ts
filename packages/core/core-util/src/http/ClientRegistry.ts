import { ErrorTranslator } from './ErrorTranslator';
import { CallOutcome, ErrorClassifier } from './ErrorClassifier';
import { CallScope, CallScopeLadder } from './CallScope';
import { WEBPIECES_DEFAULT_ERROR_CLASSIFIER } from './WebpiecesDefaultErrorClassifier';
import { WEBPIECES_DEFAULT_ERROR_TRANSLATOR } from './WebpiecesDefaultErrorTranslator';
import { ApiMethodInfo } from './ApiMethodInfo';

/** One {@link CallScope} rung of the error-translator ladder. Data only, so a class. */
class TranslatorSlot {
    translator?: ErrorTranslator;
}

/** One {@link CallScope} rung of the error-classifier ladder. Data only, so a class. */
class ClassifierSlot {
    classifier?: ErrorClassifier;
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
 */
export class ClientRegistry {
    /** svcName -> resolved base URL. Process-global; populated at startup per environment. */
    private static readonly mappings = new Map<string, string>();

    /** The fallback for svcNames with no mapping. Undefined = no derivation in this environment. */
    private static deriver: ServiceUrlDeriver | undefined;

    /**
     * The {@link ErrorTranslator} per {@link CallScope} — method -> API -> ALL, and below every rung
     * {@link WEBPIECES_DEFAULT_ERROR_TRANSLATOR}, so {@link ClientRegistry.getErrorTranslator} is
     * never undefined. Process-global, set once at startup on the SERVER and in the BROWSER — the
     * same no-DI pattern as {@link ClientRegistry.mappings} above.
     *
     * ONE translator per scope, not a list, on purpose: an app that has several layers of error
     * policy for one scope composes them INSIDE its own `toWire`, where the precedence is written
     * down. The ladder exists because vendors put their errors on the wire in their OWN formats — a
     * per-API translator reads one vendor's 4xx body (`fromWire`), or writes the error body an
     * inbound vendor expects back (`toWire`), while every other contract keeps the app's ALL one.
     */
    private static readonly errorTranslators = new CallScopeLadder<TranslatorSlot>(
        () => new TranslatorSlot(),
    );

    /**
     * The {@link ErrorClassifier} per {@link CallScope} — method -> API -> ALL, and below every rung
     * {@link WEBPIECES_DEFAULT_ERROR_CLASSIFIER}. A classifier that DEFERS (`undefined`) falls through
     * to the next rung. The ALL classifier reads {@link ApiMethodInfo.side}, so one classifier covers
     * the server router AND every internal client; an SDK-wrapping api-client registers its own at
     * its abstract `XxxApi` class. See {@link ClientRegistry.classify}.
     */
    private static readonly errorClassifiers = new CallScopeLadder<ClassifierSlot>(
        () => new ClassifierSlot(),
    );

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

    /**
     * Install an {@link ErrorTranslator} for one {@link CallScope}: `'ALL'` (the app's translator,
     * server side AND every client side), one contract CLASS, or one method of one contract. The
     * scope is REQUIRED — there is no unscoped spelling. Call at startup, on the server AND in the
     * browser, mirroring {@link ClientRegistry.addMapping}.
     *
     * ```ts
     * ClientRegistry.setErrorTranslator(new AppErrorTranslator(), 'ALL');
     * ClientRegistry.setErrorTranslator(new VendorErrorTranslator(), VendorApi);        // one contract
     * ClientRegistry.setErrorTranslator(new LegacyErrorTranslator(), VendorApi, 'sync'); // one method
     * ```
     *
     * `set`, not `add`: see the field doc above for why a per-scope LIST is not wanted. A translator
     * declines an error by DELEGATING to {@link WebpiecesDefaultErrorTranslator} — not to the next
     * rung — exactly as before.
     */
    // webpieces-disable no-function-outside-class -- static global singleton (like HeaderRegistry/LogManager); populated once at startup, never DI-injected
    static setErrorTranslator(translator: ErrorTranslator, ...scope: CallScope): void {
        ClientRegistry.errorTranslators.at(...scope).translator = translator;
    }

    /**
     * THE {@link ErrorTranslator} for one call — method -> API -> ALL ->
     * {@link WEBPIECES_DEFAULT_ERROR_TRANSLATOR}, never `undefined`, so a caller never branches.
     *
     * Both arguments are required so every call site states what it knows: the client and the server
     * pass the route's contract class and method; a failure with no route (an unmatched request, a
     * failure before routing) passes `undefined, undefined` and reaches the ALL rung alone.
     */
    // webpieces-disable no-function-outside-class -- static global singleton (like HeaderRegistry/LogManager); populated once at startup, never DI-injected
    static getErrorTranslator(api: Function | undefined, methodName: string | undefined): ErrorTranslator {
        const registered = ClientRegistry.errorTranslators
            .rungs(api, methodName)
            .find((slot: TranslatorSlot) => slot.translator !== undefined)?.translator;
        return registered ?? WEBPIECES_DEFAULT_ERROR_TRANSLATOR;
    }

    /**
     * Install an {@link ErrorClassifier} for one {@link CallScope}: `'ALL'` (the app/company
     * classifier — it reads {@link ApiMethodInfo.side}, so it covers the server router and every
     * internal client), one contract CLASS (an SDK-wrapping api-client keys by its abstract `XxxApi`),
     * or one method of one contract. The scope is REQUIRED. Call at startup, on the server AND in the
     * browser. See {@link ErrorClassifier}.
     */
    // webpieces-disable no-function-outside-class -- static global singleton (like HeaderRegistry/LogManager); populated once at startup, never DI-injected
    static setErrorClassifier(classifier: ErrorClassifier, ...scope: CallScope): void {
        ClientRegistry.errorClassifiers.at(...scope).classifier = classifier;
    }

    /**
     * The {@link CallOutcome} of a thrown API-call error. Resolved on the {@link CallScope} ladder of
     * `methodInfo.contract` / `methodInfo.methodName`, most specific first, and ALWAYS definitive:
     *   1. the method classifier — unless it defers;
     *   2. else the API classifier — unless it defers;
     *   3. else the ALL classifier — unless it defers;
     *   4. else the webpieces built-in ({@link WEBPIECES_DEFAULT_ERROR_CLASSIFIER}), which never defers.
     *
     * The ONE verdict read by `RetryStrategy` (retry only TRANSIENT), `CallRegistry`'s per-attempt
     * log line, `LogApiCall` (EXPECTED → OTHER, else FAIL) and the MCP renderer's retry advice.
     */
    // webpieces-disable no-function-outside-class -- static global singleton (like HeaderRegistry/LogManager); populated once at startup, never DI-injected
    static classify(error: Error, methodInfo: ApiMethodInfo): CallOutcome {
        const rungs = ClientRegistry.errorClassifiers.rungs(methodInfo.contract, methodInfo.methodName);
        for (const slot of rungs) {
            const verdict = slot.classifier?.classify(error, methodInfo);
            if (verdict !== undefined) {
                return verdict;
            }
        }
        return WEBPIECES_DEFAULT_ERROR_CLASSIFIER.classify(error, methodInfo);
    }

    /**
     * Put the process-globals back to the state a fresh process starts in. For TESTS, so one spec
     * cannot leak its registrations into the next.
     *
     * It empties every translator and classifier rung, which RESTORES the webpieces defaults:
     * `getErrorTranslator(...)` and `classify(...)` fall through to them below every rung, so
     * "cleared" is not a state they have. A spec that wants webpieces' own behaviour back asks for
     * exactly that.
     */
    // webpieces-disable no-function-outside-class -- static global singleton (like HeaderRegistry/LogManager); populated once at startup, never DI-injected
    static resetForTests(): void {
        ClientRegistry.mappings.clear();
        ClientRegistry.deriver = undefined;
        ClientRegistry.errorTranslators.clear();
        ClientRegistry.errorClassifiers.clear();
    }
}
